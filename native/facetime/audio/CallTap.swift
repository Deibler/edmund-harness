import AVFAudio
import CoreAudio
import Foundation

/// Captures the call's audio from the processes that render it, muted.
///
/// A Core Audio process tap with `muteBehavior = .muted` takes the tapped
/// processes' output away from every output device and hands it to us instead.
/// So the caller's voice reaches speech recognition and never reaches a
/// speaker. Which processes render FaceTime audio is configuration, not a
/// guess baked in here: the daemon names their bundle IDs.
///
/// A process gets an audio object only once it opens audio, which for a call
/// daemon may be after the call is answered. So the tap is rebuilt whenever the
/// process list changes and the set of matching processes is different.
final class CallTap {
  private let queue = DispatchQueue(label: "edmund.callaudio.tap")
  private var bundleIDs: [String] = []
  private var tapped: [HAL.AudioProcess] = []
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?
  private var listening = false
  private var listenerInstalled = false
  private let target: AVAudioFormat
  private let onAudio: (AVAudioPCMBuffer) -> Void
  private let onChange: ([HAL.AudioProcess], String?) -> Void

  /// - Parameters:
  ///   - target: the format speech recognition wants (16 kHz mono Int16 here).
  ///   - onAudio: converted buffers, on the tap's queue.
  ///   - onChange: the processes now tapped, and an error if rebuilding failed.
  init(
    target: AVAudioFormat,
    onAudio: @escaping (AVAudioPCMBuffer) -> Void,
    onChange: @escaping ([HAL.AudioProcess], String?) -> Void
  ) {
    self.target = target
    self.onAudio = onAudio
    self.onChange = onChange
  }

  func start(bundleIDs: [String]) {
    queue.async { [self] in
      self.bundleIDs = bundleIDs
      listening = true
      if !listenerInstalled {
        listenerInstalled = true
        HAL.listen(HAL.system, HAL.address(kAudioHardwarePropertyProcessObjectList), queue: queue) { [weak self] in
          self?.rebuildIfChanged()
        }
      }
      rebuildIfChanged()
    }
  }

  func stop() {
    queue.sync { [self] in
      listening = false
      teardown()
      tapped = []
    }
  }

  private func matching() -> [HAL.AudioProcess] {
    HAL.processes().filter { process in bundleIDs.contains { process.bundleID.hasPrefix($0) } }
  }

  private func rebuildIfChanged() {
    guard listening else { return }
    let now = matching()
    guard Set(now.map(\.object)) != Set(tapped.map(\.object)) else { return }
    teardown()
    tapped = now
    guard !now.isEmpty else {
      onChange([], nil)
      return
    }
    do {
      try build(now.map(\.object))
      onChange(now, nil)
    } catch {
      teardown()
      onChange(now, "\(error)")
    }
  }

  private struct TapError: Error, CustomStringConvertible {
    let description: String
  }

  private func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr { throw TapError(description: "\(what) failed (\(status))") }
  }

  private func build(_ processes: [AudioObjectID]) throws {
    let description = CATapDescription(stereoMixdownOfProcesses: processes)
    description.uuid = UUID()
    description.name = "Edmund call tap"
    description.isPrivate = true
    description.muteBehavior = .muted
    try check(AudioHardwareCreateProcessTap(description, &tapID), "AudioHardwareCreateProcessTap")

    // The aggregate needs a clock. The default output provides it; nothing is
    // ever written to it, and the output guard keeps it muted regardless.
    guard let output = HAL.defaultOutput(), let outputUID = HAL.uid(output) else {
      throw TapError(description: "no default output device to clock the tap")
    }
    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Edmund Call Tap",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
      kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]
      ],
    ]
    try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "AudioHardwareCreateAggregateDevice")

    guard var stream = HAL.get(tapID, HAL.address(kAudioTapPropertyFormat), as: AudioStreamBasicDescription.self),
      let source = AVAudioFormat(streamDescription: &stream),
      let converter = AVAudioConverter(from: source, to: target)
    else {
      throw TapError(description: "unreadable tap format")
    }
    converter.downmix = true

    let target = self.target
    let onAudio = self.onAudio
    try check(
      AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
        guard let buffer = AVAudioPCMBuffer(pcmFormat: source, bufferListNoCopy: input, deallocator: nil),
          buffer.frameLength > 0
        else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / source.sampleRate) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
          if supplied {
            status.pointee = .noDataNow
            return nil
          }
          supplied = true
          status.pointee = .haveData
          return buffer
        }
        if error == nil, out.frameLength > 0 { onAudio(out) }
      },
      "AudioDeviceCreateIOProcIDWithBlock"
    )
    try check(AudioDeviceStart(aggregateID, procID), "AudioDeviceStart")
  }

  private func teardown() {
    if aggregateID != kAudioObjectUnknown {
      if let procID {
        AudioDeviceStop(aggregateID, procID)
        AudioDeviceDestroyIOProcID(aggregateID, procID)
      }
      AudioHardwareDestroyAggregateDevice(aggregateID)
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
    }
    procID = nil
    aggregateID = AudioObjectID(kAudioObjectUnknown)
    tapID = AudioObjectID(kAudioObjectUnknown)
  }
}
