import CoreAudio
import Foundation

/// Thin, typed access to Core Audio object properties. Every call returns nil
/// (or an empty array) on failure instead of throwing: a property that cannot
/// be read is reported by the caller in its own terms.
enum HAL {
  static let system = AudioObjectID(kAudioObjectSystemObject)

  static func address(
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
  ) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
  }

  static func has(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress) -> Bool {
    var address = address
    return AudioObjectHasProperty(object, &address)
  }

  static func isSettable(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress) -> Bool {
    var address = address
    var settable: DarwinBoolean = false
    return AudioObjectIsPropertySettable(object, &address, &settable) == noErr && settable.boolValue
  }

  static func get<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, as _: T.Type) -> T? {
    var address = address
    var size = UInt32(MemoryLayout<T>.size)
    let value = UnsafeMutablePointer<T>.allocate(capacity: 1)
    defer { value.deallocate() }
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, value) == noErr else { return nil }
    return value.pointee
  }

  static func array<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, of _: T.Type) -> [T] {
    var address = address
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<T>.stride
    let values = UnsafeMutablePointer<T>.allocate(capacity: count)
    defer { values.deallocate() }
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, values) == noErr else { return [] }
    return Array(UnsafeBufferPointer(start: values, count: count))
  }

  static func string(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress) -> String? {
    var address = address
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var value: Unmanaged<CFString>?
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value?.takeRetainedValue() as String?
  }

  @discardableResult
  static func set<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, _ value: T) -> OSStatus {
    var address = address
    var value = value
    return withUnsafePointer(to: &value) {
      AudioObjectSetPropertyData(object, &address, 0, nil, UInt32(MemoryLayout<T>.size), $0)
    }
  }

  /// Calls `handler` on `queue` whenever the property changes. The listener
  /// lives as long as the process; this helper never needs to remove one.
  static func listen(
    _ object: AudioObjectID,
    _ address: AudioObjectPropertyAddress,
    queue: DispatchQueue,
    _ handler: @escaping () -> Void
  ) {
    var address = address
    AudioObjectAddPropertyListenerBlock(object, &address, queue) { _, _ in handler() }
  }

  // MARK: Devices

  static func devices() -> [AudioObjectID] {
    array(system, address(kAudioHardwarePropertyDevices), of: AudioObjectID.self)
  }

  static func name(_ device: AudioObjectID) -> String {
    string(device, address(kAudioObjectPropertyName)) ?? "device \(device)"
  }

  static func uid(_ device: AudioObjectID) -> String? {
    string(device, address(kAudioDevicePropertyDeviceUID))
  }

  static func hasOutput(_ device: AudioObjectID) -> Bool {
    !array(device, address(kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeOutput), of: AudioStreamID.self).isEmpty
  }

  static func device(named name: String) -> AudioObjectID? {
    devices().first { HAL.name($0) == name || uid($0) == name }
  }

  static func defaultOutput() -> AudioObjectID? {
    get(system, address(kAudioHardwarePropertyDefaultOutputDevice), as: AudioObjectID.self)
  }

  // MARK: Processes

  struct AudioProcess {
    let object: AudioObjectID
    let pid: pid_t
    let bundleID: String
    let runningOutput: Bool
  }

  static func processes() -> [AudioProcess] {
    array(system, address(kAudioHardwarePropertyProcessObjectList), of: AudioObjectID.self).map { object in
      AudioProcess(
        object: object,
        pid: get(object, address(kAudioProcessPropertyPID), as: pid_t.self) ?? -1,
        bundleID: string(object, address(kAudioProcessPropertyBundleID)) ?? "",
        runningOutput: (get(object, address(kAudioProcessPropertyIsRunningOutput), as: UInt32.self) ?? 0) != 0
      )
    }
  }
}
