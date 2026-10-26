// Reads and presses Bambu Connect's controls through macOS Accessibility.
//
//   connect trusted                 -> {"trusted": true|false}
//   connect tree <pid>              -> the application's tree as JSON
//   connect press <pid> <path>      -> AXPress on the element at <path>
//
// A path is the child indexes from the application element, "0.2.1". The
// caller reads the tree, picks the control by role and label, and presses it
// from that snapshot. Electron builds its accessibility tree only when asked,
// so every call sets AXManualAccessibility on the application first, and a
// fresh client may see an empty web area for a moment.
//
// press acts only inside one of the app's windows: the menu bar in the same
// tree holds the system menu (Shut Down, Log Out), which nothing here may
// reach.

import ApplicationServices
import Foundation

func out(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  out(["error": message])
  exit(1)
}

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func str(_ e: AXUIElement, _ name: String) -> String {
  guard let v = attr(e, name) else { return "" }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return ""
}

func kids(_ e: AXUIElement) -> [AXUIElement] {
  attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func app(_ pidText: String) -> AXUIElement {
  guard let pid = pid_t(pidText) else { fail("bad pid") }
  let a = AXUIElementCreateApplication(pid)
  AXUIElementSetAttributeValue(a, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  return a
}

func node(_ e: AXUIElement, path: String, depth: Int) -> [String: Any] {
  var n: [String: Any] = ["path": path, "role": str(e, kAXRoleAttribute)]
  for (key, name) in [
    ("title", kAXTitleAttribute), ("desc", kAXDescriptionAttribute), ("value", kAXValueAttribute),
    ("id", "AXDOMIdentifier"),
  ] {
    let s = str(e, name)
    if !s.isEmpty { n[key] = String(s.prefix(300)) }
  }
  if let enabled = attr(e, kAXEnabledAttribute) as? Bool, !enabled { n["disabled"] = true }
  if let classes = attr(e, "AXDOMClassList") as? [String], !classes.isEmpty {
    n["class"] = classes.joined(separator: " ")
  }
  let c = depth < 60 ? kids(e) : []
  if !c.isEmpty {
    n["children"] = c.enumerated().map {
      node($1, path: path.isEmpty ? "\($0)" : "\(path).\($0)", depth: depth + 1)
    }
  }
  return n
}

func resolve(_ root: AXUIElement, _ path: String) -> AXUIElement? {
  var e = root
  for part in path.split(separator: ".") {
    guard let i = Int(part) else { return nil }
    let c = kids(e)
    guard i < c.count else { return nil }
    e = c[i]
  }
  return e
}

/** Polls until `ready` holds or about three seconds pass. */
func settle<T>(_ read: () -> T?) -> T? {
  for _ in 0..<20 {
    if let v = read() { return v }
    usleep(150_000)
  }
  return nil
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: connect trusted | tree <pid> | press <pid> <path>") }
switch args[1] {
case "trusted":
  out(["trusted": AXIsProcessTrusted()])
case "tree":
  guard args.count >= 3 else { fail("tree needs a pid") }
  let a = app(args[2])
  // Wait for a web area with content; a window with no page yet is not an answer.
  _ = settle { () -> Bool? in
    func filled(_ e: AXUIElement, _ depth: Int) -> Bool {
      if str(e, kAXRoleAttribute) == "AXWebArea" { return !kids(e).isEmpty }
      return depth < 8 && kids(e).contains { filled($0, depth + 1) }
    }
    return kids(a).contains { filled($0, 0) } ? true : nil
  }
  out(node(a, path: "", depth: 0))
case "press":
  guard args.count >= 4 else { fail("press needs a pid and a path") }
  let a = app(args[2])
  let path = args[3]
  guard let first = path.split(separator: ".").first, let i = Int(first) else { fail("bad path") }
  let top = kids(a)
  guard i < top.count, str(top[i], kAXRoleAttribute) == "AXWindow" else {
    fail("refused: \(path) is not inside a window")
  }
  guard let e = settle({ resolve(a, path) }) else { fail("no element at \(path)") }
  let err = AXUIElementPerformAction(e, kAXPressAction as CFString)
  if err != .success { fail("press failed: \(err.rawValue)") }
  out(["pressed": path, "role": str(e, kAXRoleAttribute)])
default:
  fail("unknown command \(args[1])")
}
