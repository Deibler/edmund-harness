// EdmundMouth: Edmund's voice on a call.
//
// Plays synthesised speech into the virtual microphone FaceTime listens to.
// It needs no privacy permission (playing audio is not capturing it), which is
// why it is its own program: the listening helper holds the audio-capture
// grant, and macOS ties that grant to the exact build, so every change to the
// voice used to cost a fresh manual grant. Now only listening changes do.
//
// Same newline-delimited JSON socket protocol as the other helpers.
//
// It also reports which devices the call is really using (`route`): it is the
// helper that can read Core Audio without any permission.
//
//   EdmundMouth --socket <path> [--device "Edmund Feed"] [--rate 24000]

import Foundation

final class Voice {
  private var wire: Wire!
  private var mouth: Mouth?
  private var mouthError: String?
  /// Chunks queued and not yet finished, in order.
  private var pending: [String] = []
  private let state = DispatchQueue(label: "edmund.mouth.state")

  init(socketPath: String, device: String, sampleRate: Double) {
    wire = Wire(
      path: socketPath,
      onConnect: { [unowned self] in wire.event("hello", status()) },
      onMessage: { [unowned self] in handle($0) }
    )
    do {
      mouth = try Mouth(deviceName: device, sampleRate: sampleRate)
    } catch {
      mouthError = error.localizedDescription
    }
  }

  func start() {
    wire.start()
  }

  /// Where the voice is really going, as Core Audio reports it, and how loud
  /// it is right now: the first live call reported "played" for speech that
  /// had gone to a muted speaker.
  private func status() -> [String: Any] {
    [
      "pid": Int(getpid()),
      "device": mouth?.deviceName ?? NSNull(),
      "currentDevice": mouth?.currentDevice() ?? NSNull(),
      "running": mouth?.isRunning() ?? false,
      "levelDb": mouth?.levelDb() ?? -120,
      "error": mouthError ?? NSNull(),
    ]
  }

  private func handle(_ message: Wire.Message) {
    let id = message["id"]
    let params = message["params"] as? Wire.Message ?? [:]
    switch message["method"] as? String ?? "" {
    case "ping":
      wire.reply(id, result: "pong")
    case "status":
      wire.reply(id, result: status())
    case "route":
      wire.reply(id, result: Route.report(bundleIDs: params["bundleIds"] as? [String] ?? []))
    case "say":
      say(id: id, params: params)
    case "flush":
      let dropped = state.sync { pending }
      mouth?.flush()
      wire.reply(id, result: ["flushed": dropped])
    default:
      wire.reply(id, error: "unknown method \(message["method"] ?? "nil")")
    }
  }

  private func say(id: Any?, params: Wire.Message) {
    guard let mouth else {
      wire.reply(id, error: mouthError ?? "no voice device")
      return
    }
    guard let chunkID = params["id"] as? String,
      let base64 = params["pcm"] as? String,
      let pcm = Data(base64Encoded: base64)
    else {
      wire.reply(id, error: "say needs id and base64 pcm")
      return
    }
    state.sync { pending.append(chunkID) }
    // Sampled halfway through the chunk: the level while it is audible.
    let halfway = Double(pcm.count) / 2 / 24_000 / 2
    var midLevel: Float = -120
    DispatchQueue.global().asyncAfter(deadline: .now() + halfway) { midLevel = mouth.levelDb() }
    mouth.say(id: chunkID, pcm16: pcm) { [unowned self] consumed in
      state.sync { pending.removeAll { $0 == chunkID } }
      // Played means consumed AND audible: a stream whose device was taken
      // under it consumes buffers on time while rendering silence.
      wire.event("spoken", [
        "id": chunkID,
        "played": consumed && midLevel > -100,
        "consumed": consumed,
        "midLevelDb": midLevel,
        "currentDevice": mouth.currentDevice() ?? NSNull(),
        "running": mouth.isRunning(),
      ])
    }
    wire.reply(id, result: ["queued": chunkID])
  }
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

guard let socketPath = argument("--socket") else {
  FileHandle.standardError.write("usage: EdmundMouth --socket <path> [--device <name>] [--rate <hz>]\n".data(using: .utf8)!)
  exit(64)
}

let voice = Voice(
  socketPath: socketPath,
  device: argument("--device") ?? "Edmund Feed",
  sampleRate: Double(argument("--rate") ?? "") ?? 24_000
)
voice.start()
RunLoop.main.run()
