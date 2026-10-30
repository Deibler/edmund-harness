import AVFAudio
import Foundation

/// The caller's last few seconds of audio at 16 kHz mono, 16-bit: what the
/// turn detector (Smart Turn) reads to judge whether they have finished, and
/// the cheap voice-activity check that says when to ask it.
///
/// Indexed by audio time from the first buffer of the session, the same clock
/// the analyzer's results use, so a clip can end exactly where the caller
/// stopped. Fed from the tap's queue and read from other tasks, so every
/// access takes the lock.
///
/// The pause comes from here, not from Apple's SpeechDetector: fed the same
/// speech, the detector reported nothing at all, and the transcriber's final
/// result came 1.5-2.1 s after the speech ended (2026-10-29, hearing-sim).
final class RecentAudio: @unchecked Sendable {
  static let format = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  private static let rate = 16_000

  private let lock = NSLock()
  private let capacity: Int
  private var samples: [Int16] = []
  /// Samples appended this session; samples[0] is sample `total - samples.count`.
  private var total = 0
  private var converter: AVAudioConverter?
  private var origin: Double?
  private var activity = VoiceActivity()
  /// Called (off the lock) with the audio time in ms where the caller stopped.
  var onPause: ((Int) -> Void)?
  /// Called (off the lock) with the audio time in ms where they started again.
  var onSpeechStart: ((Int) -> Void)?

  init(seconds: Int) {
    capacity = seconds * Self.rate
  }

  /// Wall-clock time (unix ms) of the session's first audio: add a result's
  /// audio time to it to get when that speech happened.
  var originMs: Double? {
    lock.withLock { origin }
  }

  func append(_ buffer: AVAudioPCMBuffer) {
    let converted = convert(buffer)
    let events = lock.withLock { () -> [VoiceActivity.Event] in
      if origin == nil { origin = Date().timeIntervalSince1970 * 1000 }
      let start = total
      samples.append(contentsOf: converted)
      total += converted.count
      if samples.count > capacity { samples.removeFirst(samples.count - capacity) }
      return activity.feed(converted, startSample: start)
    }
    for event in events {
      switch event {
      case .start(let sample): onSpeechStart?(sample * 1000 / Self.rate)
      case .pause(let sample): onPause?(sample * 1000 / Self.rate)
      }
    }
  }

  /// Up to `seconds` of audio ending `endMs` into the session, as base64
  /// little-endian 16-bit PCM. Nil when none of it is still held.
  func clip(endingAtMs endMs: Int, seconds: Int) -> String? {
    lock.withLock {
      let first = total - samples.count
      let end = min(total, endMs * Self.rate / 1000)
      let start = max(first, end - seconds * Self.rate)
      guard end > start else { return nil }
      let slice = Array(samples[(start - first)..<(end - first)])
      return slice.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
    }
  }

  func reset() {
    lock.withLock {
      samples = []
      total = 0
      origin = nil
      converter = nil
      activity = VoiceActivity()
    }
  }

  private func convert(_ buffer: AVAudioPCMBuffer) -> [Int16] {
    let target = Self.format
    if buffer.format == target, let data = buffer.int16ChannelData {
      return Array(UnsafeBufferPointer(start: data[0], count: Int(buffer.frameLength)))
    }
    let converter = lock.withLock { () -> AVAudioConverter? in
      if self.converter == nil || self.converter?.inputFormat != buffer.format {
        self.converter = AVAudioConverter(from: buffer.format, to: target)
      }
      return self.converter
    }
    guard let converter else { return [] }
    let capacity = AVAudioFrameCount(
      Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
    var consumed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, let data = out.int16ChannelData else { return [] }
    return Array(UnsafeBufferPointer(start: data[0], count: Int(out.frameLength)))
  }
}

/// When the caller is talking, from the energy of 20 ms frames against an
/// adaptive noise floor. A pause is 240 ms of quiet after at least 60 ms of
/// speech: short enough to ask the turn detector early, which decides whether
/// the pause ends the turn.
struct VoiceActivity {
  enum Event { case start(Int), pause(Int) }
  private static let frame = 320  // 20 ms at 16 kHz
  private static let speechFramesToStart = 3
  private static let quietFramesToPause = 12
  private var pending: [Int16] = []
  private var pendingStart = 0
  private var floorDb: Double = -70
  private var speechRun = 0
  private var quietRun = 0
  private var speaking = false
  private var firstQuietSample = 0
  private var firstVoicedSample = 0

  /// Feeds samples starting at `startSample`; returns where speech started
  /// and where each pause began, as sample indices.
  mutating func feed(_ samples: [Int16], startSample: Int) -> [Event] {
    if pending.isEmpty { pendingStart = startSample }
    pending.append(contentsOf: samples)
    var events: [Event] = []
    var offset = 0
    while pending.count - offset >= Self.frame {
      let frameStart = pendingStart + offset
      var energy = 0.0
      for i in offset..<(offset + Self.frame) {
        let x = Double(pending[i]) / 32768
        energy += x * x
      }
      offset += Self.frame
      let db = 10 * log10(max(energy / Double(Self.frame), 1e-12))
      // The floor follows quiet quickly and loud slowly, so a long sentence
      // does not become the new "quiet".
      floorDb = db < floorDb ? db : floorDb + 0.02
      let voiced = db > max(-50, floorDb + 12)
      if voiced {
        if speechRun == 0 { firstVoicedSample = frameStart }
        speechRun += 1
        quietRun = 0
        if speechRun >= Self.speechFramesToStart && !speaking {
          speaking = true
          events.append(.start(firstVoicedSample))
        }
      } else {
        if quietRun == 0 { firstQuietSample = frameStart }
        quietRun += 1
        speechRun = 0
        if speaking && quietRun >= Self.quietFramesToPause {
          speaking = false
          events.append(.pause(firstQuietSample))
        }
      }
    }
    pending.removeFirst(offset)
    pendingStart += offset
    return events
  }
}
