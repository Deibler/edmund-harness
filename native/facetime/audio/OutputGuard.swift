import CoreAudio
import Foundation

/// Keeps every physical output on this Mac silent, and reports when it isn't.
///
/// The rule: a physical output device must be muted (or at zero volume when it
/// has no mute control). Virtual and aggregate devices are exempt. The mouth is
/// a virtual device whose only listener is FaceTime's microphone input.
///
/// This is the floor under the call tap's own mute. Ringtones, connect chimes
/// and alerts come from processes the tap does not cover, so the hardware
/// itself has to be silent. The guard re-asserts the mute every time a device
/// appears or its mute, volume or running state changes, and reports every
/// correction so the daemon can hang up and tell the operator.
final class OutputGuard {
  struct Report {
    let device: AudioObjectID
    let name: String
    let running: Bool
    let muted: Bool?
    let volume: Float32?
    var audible: Bool { muted != true && (volume ?? 1) > 0 }

    var json: [String: Any] {
      [
        "device": name,
        "running": running,
        "muted": muted.map { $0 as Any } ?? NSNull(),
        "volume": volume.map { $0 as Any } ?? NSNull(),
        "audible": audible,
      ]
    }
  }

  private let queue = DispatchQueue(label: "edmund.callaudio.guard")
  private var watched = Set<AudioObjectID>()
  private let onCorrection: (Report, String) -> Void

  init(onCorrection: @escaping (Report, String) -> Void) {
    self.onCorrection = onCorrection
  }

  func start() {
    queue.async { [self] in
      HAL.listen(HAL.system, HAL.address(kAudioHardwarePropertyDevices), queue: queue) { [weak self] in
        self?.sweep(reason: "device list changed")
      }
      sweep(reason: "start")
    }
  }

  /// Every physical output and its state right now.
  func reports() -> [Report] {
    queue.sync { physicalOutputs().map(report) }
  }

  private static func isPhysical(_ device: AudioObjectID) -> Bool {
    let transport = HAL.get(device, HAL.address(kAudioDevicePropertyTransportType), as: UInt32.self) ?? 0
    return transport != kAudioDeviceTransportTypeVirtual && transport != kAudioDeviceTransportTypeAggregate
  }

  private func physicalOutputs() -> [AudioObjectID] {
    HAL.devices().filter { HAL.hasOutput($0) && Self.isPhysical($0) }
  }

  private static let mute = HAL.address(kAudioDevicePropertyMute, scope: kAudioObjectPropertyScopeOutput)
  private static let running = HAL.address(kAudioDevicePropertyDeviceIsRunningSomewhere)
  /// Built-in speakers often have no master volume, only per-channel ones, so
  /// the main element and the first two channels are all checked.
  private static let volumes = [kAudioObjectPropertyElementMain, 1, 2].map {
    HAL.address(kAudioDevicePropertyVolumeScalar, scope: kAudioObjectPropertyScopeOutput, element: $0)
  }

  private static func loudestVolume(_ device: AudioObjectID) -> Float32? {
    volumes.filter { HAL.has(device, $0) }.compactMap { HAL.get(device, $0, as: Float32.self) }.max()
  }

  private func report(_ device: AudioObjectID) -> Report {
    Report(
      device: device,
      name: HAL.name(device),
      running: (HAL.get(device, Self.running, as: UInt32.self) ?? 0) != 0,
      muted: HAL.has(device, Self.mute) ? (HAL.get(device, Self.mute, as: UInt32.self) ?? 0) != 0 : nil,
      volume: Self.loudestVolume(device)
    )
  }

  private func sweep(reason: String) {
    for device in physicalOutputs() {
      if !watched.contains(device) {
        watched.insert(device)
        for address in [Self.mute, Self.running] + Self.volumes where HAL.has(device, address) {
          HAL.listen(device, address, queue: queue) { [weak self] in
            self?.enforce(device, reason: "state changed")
          }
        }
      }
      enforce(device, reason: reason)
    }
  }

  private func enforce(_ device: AudioObjectID, reason: String) {
    let before = report(device)
    guard before.audible else { return }
    if HAL.isSettable(device, Self.mute) {
      HAL.set(device, Self.mute, UInt32(1))
    }
    for volume in Self.volumes where HAL.isSettable(device, volume) {
      HAL.set(device, volume, Float32(0))
    }
    onCorrection(report(device), "\(reason): \(before.name) was audible (running=\(before.running))")
  }
}
