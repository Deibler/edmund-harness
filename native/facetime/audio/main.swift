// EdmundCallAudio: Edmund's hearing on FaceTime calls.
//
//   hearing  a muted process tap on the call audio -> on-device SpeechAnalyzer
//   guard    every physical output stays muted; corrections are reported
//
// Edmund's voice is a separate program (mouth/, EdmundMouth): this one holds
// the audio-capture permission, which macOS ties to the exact build, so it is
// kept small and rebuilt only when hearing changes. It decides nothing about
// calls; the daemon tells it when to listen, over the same newline-delimited
// JSON socket protocol FaceTimeControl uses. It ships as an app bundle so
// macOS attributes the permission to it rather than to whatever launched it.
//
//   EdmundCallAudio --socket <path>

import AVFAudio
import Foundation

final class Helper {
  private var wire: Wire!
  private var outputGuard: OutputGuard!
  private var hearing: Hearing!
  private var tap: CallTap?
  private let state = DispatchQueue(label: "edmund.callaudio.state")
  private var listening = false
  private var tappedProcesses: [[String: Any]] = []

  init(socketPath: String) {
    wire = Wire(
      path: socketPath,
      onConnect: { [unowned self] in sayHello() },
      onMessage: { [unowned self] in handle($0) }
    )
    outputGuard = OutputGuard { [unowned self] report, reason in
      var fields = report.json
      fields["reason"] = reason
      wire.event("guard", fields)
    }
    hearing = Hearing { [unowned self] name, fields in wire.event(name, fields) }
  }

  func start() {
    outputGuard.start()
    wire.start()
  }

  /// Carries the guard state because the guard's first sweep runs before the
  /// daemon connects; its corrections at startup would otherwise go unheard.
  private func sayHello() {
    wire.event("hello", [
      "pid": Int(getpid()),
      "guard": outputGuard.reports().map(\.json),
    ])
  }

  private func handle(_ message: Wire.Message) {
    let id = message["id"]
    let params = message["params"] as? Wire.Message ?? [:]
    switch message["method"] as? String ?? "" {
    case "ping":
      wire.reply(id, result: "pong")
    case "status":
      wire.reply(id, result: status())
    case "processes":
      wire.reply(id, result: HAL.processes().map(Self.describe))
    case "listen":
      listen(id: id, params: params)
    case "stopListening":
      stopListening(id: id)
    default:
      wire.reply(id, error: "unknown method \(message["method"] ?? "nil")")
    }
  }

  private func status() -> [String: Any] {
    [
      "guard": outputGuard.reports().map(\.json),
      "listening": state.sync { listening },
      "tapped": state.sync { tappedProcesses },
    ]
  }

  private static func describe(_ process: HAL.AudioProcess) -> [String: Any] {
    ["pid": Int(process.pid), "bundleID": process.bundleID, "runningOutput": process.runningOutput]
  }

  private func listen(id: Any?, params: Wire.Message) {
    let bundleIDs = params["bundleIds"] as? [String] ?? []
    guard !bundleIDs.isEmpty else {
      wire.reply(id, error: "listen needs bundleIds")
      return
    }
    let locale = Locale(identifier: params["locale"] as? String ?? "en-US")
    Task {
      do {
        let format: AVAudioFormat
        if let ready = hearing.format {
          format = ready
        } else {
          format = try await hearing.start(locale: locale)
        }
        if tap == nil {
          tap = CallTap(
            target: format,
            onAudio: { [hearing] buffer in hearing?.feed(buffer) },
            onChange: { [unowned self] processes, error in
              let described = processes.map(Self.describe)
              state.sync { tappedProcesses = described }
              wire.event("listening", ["processes": described, "error": error ?? NSNull()])
            })
        }
        state.sync { listening = true }
        tap?.start(bundleIDs: bundleIDs)
        wire.reply(id, result: ["format": "\(format)"])
      } catch {
        wire.reply(id, error: "\(error)")
      }
    }
  }

  private func stopListening(id: Any?) {
    tap?.stop()
    state.sync {
      listening = false
      tappedProcesses = []
    }
    Task {
      await hearing.stop()
      wire.reply(id, result: true)
    }
  }
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

guard let socketPath = argument("--socket") else {
  FileHandle.standardError.write("usage: EdmundCallAudio --socket <path>\n".data(using: .utf8)!)
  exit(64)
}

let helper = Helper(socketPath: socketPath)
helper.start()
RunLoop.main.run()
