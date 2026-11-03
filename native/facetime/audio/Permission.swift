import Foundation

/// Whether macOS lets this build hear other processes' audio, asked of the
/// permission service without prompting.
///
/// Without the permission a tap still builds and runs, and either fails or
/// streams silence, so a call would look heard and be deaf. macOS never
/// prompts this helper (tccd: "Policy disallows prompt"), and an ad-hoc
/// signature ties a grant to one exact build: every rebuild lost it on
/// 2026-10-29 and 2026-10-30. The daemon asks for this before every call and
/// refuses the call unless it reads "granted".
///
/// There is no public API for this permission. TCCAccessPreflight is the
/// private call the system's own clients use. Measured on macOS 26.4: 0 for a
/// grant this identity holds, 2 for a build whose grant was made for another
/// build (tccd: "Failed to match existing code requirement"). If the call
/// ever goes missing the answer is "unavailable", which refuses calls too.
enum CapturePermission {
  private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int32

  private static let preflight: Preflight? = {
    guard let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
      let symbol = dlsym(tcc, "TCCAccessPreflight")
    else { return nil }
    return unsafeBitCast(symbol, to: Preflight.self)
  }()

  /// "granted", "denied", "undecided" (no grant applies to this build), or
  /// "unavailable" (no way to ask).
  static func current() -> String {
    guard let preflight else { return "unavailable" }
    switch preflight("kTCCServiceAudioCapture" as CFString, nil) {
    case 0: return "granted"
    case 1: return "denied"
    default: return "undecided"
    }
  }
}
