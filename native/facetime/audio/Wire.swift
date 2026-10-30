import Foundation

/// Newline-delimited JSON to and from the daemon over a Unix socket the daemon
/// listens on. Same protocol as FaceTimeControl: the helper dials out and keeps
/// redialling, so a daemon restart never needs the helper relaunched.
final class Wire {
  typealias Message = [String: Any]

  private let path: String
  private let writeQueue = DispatchQueue(label: "edmund.callaudio.write")
  private var socket: Int32 = -1
  private let onMessage: (Message) -> Void
  private let onConnect: () -> Void

  init(path: String, onConnect: @escaping () -> Void, onMessage: @escaping (Message) -> Void) {
    self.path = path
    self.onConnect = onConnect
    self.onMessage = onMessage
  }

  func start() {
    Thread.detachNewThread { [self] in readLoop() }
  }

  func send(_ message: Message) {
    guard JSONSerialization.isValidJSONObject(message),
      var line = try? JSONSerialization.data(withJSONObject: message)
    else {
      FileHandle.standardError.write("unserialisable message: \(message)\n".data(using: .utf8)!)
      return
    }
    line.append(0x0A)
    writeQueue.async { [self] in
      guard socket >= 0 else { return }
      line.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
          let n = write(socket, raw.baseAddress! + offset, raw.count - offset)
          if n <= 0 { return }  // The reader notices the dead socket and redials.
          offset += n
        }
      }
    }
  }

  func event(_ name: String, _ fields: Message = [:]) {
    var message = fields
    message["event"] = name
    send(message)
  }

  func reply(_ id: Any?, result: Any? = nil, error: String? = nil) {
    guard let id else { return }
    if let error {
      send(["id": id, "ok": false, "error": error])
    } else {
      send(["id": id, "ok": true, "result": result ?? NSNull()])
    }
  }

  private func dial() -> Int32 {
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    withUnsafeMutableBytes(of: &addr.sun_path) { buffer in
      _ = path.withCString { strlcpy(buffer.baseAddress!.assumingMemoryBound(to: CChar.self), $0, capacity) }
    }
    let connected = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if connected != 0 {
      close(fd)
      return -1
    }
    return fd
  }

  private func readLoop() {
    var backoff: useconds_t = 500_000
    while true {
      let fd = dial()
      if fd < 0 {
        usleep(backoff)
        backoff = min(backoff * 2, 5_000_000)
        continue
      }
      backoff = 500_000
      writeQueue.sync { socket = fd }
      onConnect()

      var buffer = Data()
      var chunk = [UInt8](repeating: 0, count: 65_536)
      while true {
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { break }
        buffer.append(chunk, count: n)
        while let newline = buffer.firstIndex(of: 0x0A) {
          let line = buffer[buffer.startIndex..<newline]
          buffer.removeSubrange(buffer.startIndex...newline)
          if let message = try? JSONSerialization.jsonObject(with: line) as? Message {
            onMessage(message)
          }
        }
      }
      writeQueue.sync { socket = -1 }
      close(fd)
    }
  }
}
