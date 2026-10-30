import CoreAudio
import Foundation

/// The devices a call's audio processes are really using, as Core Audio
/// reports them per process. Reported, never judged: the provider decides
/// whether the caller can hear Edmund on this route.
///
/// The process device list, not the default device: FaceTime's microphone
/// stream opens about two seconds after the call reports active, and only the
/// process list says when it has, and on which device.
enum Route {
  static func report(bundleIDs: [String]) -> [String: Any] {
    let processes = HAL.processes().filter { process in
      bundleIDs.contains { process.bundleID.hasPrefix($0) }
    }
    let defaultInput = HAL.get(
      HAL.system, HAL.address(kAudioHardwarePropertyDefaultInputDevice), as: AudioObjectID.self)
    return [
      "defaultInput": defaultInput.map(HAL.name) ?? NSNull(),
      "processes": processes.map { process -> [String: Any] in
        [
          "pid": Int(process.pid),
          "bundleID": process.bundleID,
          "runningInput": (HAL.get(
            process.object, HAL.address(kAudioProcessPropertyIsRunningInput), as: UInt32.self) ?? 0) != 0,
          "runningOutput": process.runningOutput,
          // A device can appear under input scope without input streams
          // (OpenClaw saw an output-only speaker there during a handoff).
          // Only a device with input streams can be the microphone.
          "inputs": devices(of: process.object, scope: kAudioObjectPropertyScopeInput)
            .filter(hasInput).map(HAL.name),
          "outputs": devices(of: process.object, scope: kAudioObjectPropertyScopeOutput).map { device in
            ["name": HAL.name(device), "physical": isPhysical(device)]
          },
        ]
      },
    ]
  }

  private static func devices(of process: AudioObjectID, scope: AudioObjectPropertyScope) -> [AudioObjectID] {
    HAL.array(process, HAL.address(kAudioProcessPropertyDevices, scope: scope), of: AudioObjectID.self)
  }

  private static func hasInput(_ device: AudioObjectID) -> Bool {
    !HAL.array(device, HAL.address(kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput), of: AudioStreamID.self).isEmpty
  }

  /// A real speaker or headphone: not an aggregate, not a virtual device.
  private static func isPhysical(_ device: AudioObjectID) -> Bool {
    let objectClass = HAL.get(device, HAL.address(kAudioObjectPropertyClass), as: AudioClassID.self)
    let transport = HAL.get(device, HAL.address(kAudioDevicePropertyTransportType), as: UInt32.self)
    return objectClass != kAudioAggregateDeviceClassID && transport != nil
      && transport != kAudioDeviceTransportTypeVirtual
  }
}
