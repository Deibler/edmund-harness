import AudioToolbox
import CoreAudio
import Foundation

/// Plays Edmund's speech into the virtual microphone FaceTime listens to.
///
/// One AudioQueue per burst of speech, pinned to that device by UID: opened
/// when Edmund starts talking, closed when he finishes or is interrupted.
/// What the live calls of 2026-10-29 showed, in order:
///
///  - AVAudioEngine follows the DEFAULT output when its device is
///    reconfigured. FaceTime reconfigures the virtual mic when a call
///    connects, and the engine moved Edmund onto the muted Mac mini speaker
///    ("requesting device change from 52 to 93").
///  - A long-lived AudioQueue stays pinned but does not survive that
///    reconfiguration either: its IO restart fails ("Start failed … error
///    35") and from then on it renders silence (-120 dB at mid-chunk) while
///    still consuming buffers and reporting them played.
///  - macOS `say -a`, which opens a fresh output for every utterance, reached
///    FaceTime's microphone on the same call.
///
/// So nothing here outlives a burst. A queue that stops on its own mid-burst
/// fails its chunks as unplayed rather than being restarted, and the next
/// burst opens a fresh one.
final class Mouth {
  private var queue: AudioQueueRef?
  private var format: AudioStreamBasicDescription
  private let callbacks = DispatchQueue(label: "edmund.mouth.callbacks")
  private var pending: [AudioQueueBufferRef: (id: String, done: (Bool) -> Void)] = [:]
  /// True while close() stops a queue on purpose.
  private var closing = false
  private let deviceUID: String
  let deviceName: String

  /// - Parameter sampleRate: the rate every chunk is synthesised at (Kokoro: 24 kHz).
  init(deviceName: String, sampleRate: Double) throws {
    guard let device = HAL.device(named: deviceName), let uid = HAL.uid(device) else {
      throw NSError(domain: "Mouth", code: 1, userInfo: [NSLocalizedDescriptionKey: "no audio device named \(deviceName)"])
    }
    self.deviceName = deviceName
    deviceUID = uid
    format = AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
      mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
      mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
  }

  /// The device the current stream plays to, as Core Audio reports it; nil
  /// between bursts, when no stream is open.
  func currentDevice() -> String? {
    guard let queue else { return nil }
    var uid: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioQueueGetProperty(queue, kAudioQueueProperty_CurrentDevice, &uid, &size) == noErr else { return nil }
    return uid?.takeUnretainedValue() as String?
  }

  /// Queue one chunk. `done(played)` is false when it was dropped (a flush, or
  /// a stream that stopped under it).
  func say(id: String, pcm16: Data, done: @escaping (Bool) -> Void) {
    guard !pcm16.isEmpty else {
      done(false)
      return
    }
    // A new burst gets a new stream; chunks of one burst share it.
    let idle = callbacks.sync { pending.isEmpty }
    if idle || queue == nil {
      close()
      do {
        try open()
      } catch {
        FileHandle.standardError.write("mouth: \(error.localizedDescription)\n".data(using: .utf8)!)
        done(false)
        return
      }
    }
    guard let queue else {
      done(false)
      return
    }
    var buffer: AudioQueueBufferRef?
    guard AudioQueueAllocateBuffer(queue, UInt32(pcm16.count), &buffer) == noErr, let buffer else {
      done(false)
      return
    }
    pcm16.withUnsafeBytes { raw in
      buffer.pointee.mAudioData.copyMemory(from: raw.baseAddress!, byteCount: pcm16.count)
    }
    buffer.pointee.mAudioDataByteSize = UInt32(pcm16.count)
    callbacks.sync { pending[buffer] = (id, done) }
    if AudioQueueEnqueueBuffer(queue, buffer, 0, nil) != noErr {
      callbacks.sync { _ = pending.removeValue(forKey: buffer) }
      AudioQueueFreeBuffer(queue, buffer)
      done(false)
    }
  }

  /// Drop everything queued or playing (barge-in). Dropped chunks report back
  /// as not played; the next chunk opens a fresh stream.
  func flush() {
    close()
  }

  /// Average output level of the current stream in dB (-120 when silent or
  /// when no stream is open).
  func levelDb() -> Float {
    guard let queue else { return -120 }
    var meter = AudioQueueLevelMeterState(mAveragePower: -120, mPeakPower: -120)
    var size = UInt32(MemoryLayout<AudioQueueLevelMeterState>.size)
    guard AudioQueueGetProperty(queue, kAudioQueueProperty_CurrentLevelMeterDB, &meter, &size) == noErr else {
      return -120
    }
    return meter.mAveragePower
  }

  func isRunning() -> Bool {
    guard let queue else { return false }
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    AudioQueueGetProperty(queue, kAudioQueueProperty_IsRunning, &running, &size)
    return running != 0
  }

  // MARK: Stream lifecycle

  private func open() throws {
    var created: AudioQueueRef?
    try check(
      AudioQueueNewOutputWithDispatchQueue(&created, &format, 0, callbacks) { [weak self] _, buffer in
        self?.finished(buffer)
      }, "AudioQueueNewOutput")
    guard let created else { throw NSError(domain: "Mouth", code: 2) }
    var uid = deviceUID as CFString
    let pinned = withUnsafePointer(to: &uid) {
      AudioQueueSetProperty(created, kAudioQueueProperty_CurrentDevice, $0, UInt32(MemoryLayout<CFString>.size))
    }
    guard pinned == noErr else {
      AudioQueueDispose(created, true)
      throw NSError(domain: "Mouth", code: Int(pinned), userInfo: [NSLocalizedDescriptionKey: "could not pin to \(deviceName) (\(pinned))"])
    }
    var metering: UInt32 = 1
    AudioQueueSetProperty(created, kAudioQueueProperty_EnableLevelMetering, &metering, UInt32(MemoryLayout<UInt32>.size))
    AudioQueueAddPropertyListener(created, kAudioQueueProperty_IsRunning, { context, queue, _ in
      Unmanaged<Mouth>.fromOpaque(context!).takeUnretainedValue().onRunningChanged(queue)
    }, Unmanaged.passUnretained(self).toOpaque())
    let started = AudioQueueStart(created, nil)
    guard started == noErr else {
      AudioQueueDispose(created, true)
      throw NSError(domain: "Mouth", code: Int(started), userInfo: [NSLocalizedDescriptionKey: "could not start on \(deviceName) (\(started))"])
    }
    queue = created
  }

  /// Stop and dispose the current stream; every chunk it still held reports
  /// back as not played.
  private func close() {
    guard let current = queue else { return }
    closing = true
    queue = nil
    AudioQueueStop(current, true)
    let dropped = callbacks.sync { () -> [(AudioQueueBufferRef, (Bool) -> Void)] in
      let all = pending.map { ($0.key, $0.value.done) }
      pending.removeAll()
      return all
    }
    for (_, done) in dropped { done(false) }
    AudioQueueDispose(current, true)
    closing = false
  }

  private func finished(_ buffer: AudioQueueBufferRef) {
    // On `callbacks`: the queue delivers its callbacks there.
    guard let entry = pending.removeValue(forKey: buffer) else { return }
    if let queue { AudioQueueFreeBuffer(queue, buffer) }
    entry.done(true)
  }

  /// The stream stopped without being asked (its device was taken or
  /// reconfigured under it). Its chunks did not play; the next burst opens a
  /// fresh stream rather than trusting this one to recover.
  private func onRunningChanged(_ stopped: AudioQueueRef) {
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    AudioQueueGetProperty(stopped, kAudioQueueProperty_IsRunning, &running, &size)
    guard running == 0, !closing, stopped == queue else { return }
    DispatchQueue.global().async { [weak self] in self?.close() }
  }

  private func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr {
      throw NSError(domain: "Mouth", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "\(what) failed (\(status))"])
    }
  }
}
