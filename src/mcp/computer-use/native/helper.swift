// Native side of the computer-use MCP server.
//
// A long-lived process that reads one JSON request per line on stdin and
// writes one JSON response per line on stdout. It does only what TypeScript
// cannot: capture the screen, post input events, and ask AppKit about apps
// and windows. Policy (which apps are granted, what a key name means, how
// screenshot pixels map to points) lives in the TypeScript side.
//
// Coordinates are global display points with the origin at the top-left of
// the main display, the space CGEvent and CGDisplayBounds already use.
//
// macOS attributes Screen Recording and Accessibility to the process that
// launched this one (for the daemon, the launchd job), not to this binary.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

typealias JSON = [String: Any]

struct HelperError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

// MARK: - Arguments

func num(_ req: JSON, _ key: String) throws -> Double {
  guard let v = req[key] as? NSNumber else { throw HelperError("missing number: \(key)") }
  return v.doubleValue
}

func str(_ req: JSON, _ key: String) throws -> String {
  guard let v = req[key] as? String else { throw HelperError("missing string: \(key)") }
  return v
}

func flags(_ req: JSON) -> CGEventFlags {
  CGEventFlags(rawValue: (req["flags"] as? NSNumber)?.uint64Value ?? 0)
}

func pause(_ ms: Double) { usleep(useconds_t(ms * 1000)) }

// MARK: - Displays

func activeDisplays() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  return Array(ids.prefix(Int(count)))
}

func displays() -> [JSON] {
  let ids = activeDisplays()
  let names = Dictionary(
    NSScreen.screens.compactMap { screen -> (CGDirectDisplayID, String)? in
      guard let n = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
      else { return nil }
      return (n.uint32Value, screen.localizedName)
    },
    uniquingKeysWith: { a, _ in a })
  return ids.map { id in
    let b = CGDisplayBounds(id)
    let pixelWidth = CGDisplayCopyDisplayMode(id)?.pixelWidth ?? Int(b.width)
    return [
      "id": id,
      "name": names[id].flatMap { $0.isEmpty ? nil : $0 } ?? "Display \(id)",
      "x": b.origin.x, "y": b.origin.y, "width": b.width, "height": b.height,
      "scale": Double(pixelWidth) / Double(b.width),
      "main": CGDisplayIsMain(id) != 0,
    ]
  }
}

// MARK: - Apps and windows

func describe(_ app: NSRunningApplication) -> JSON {
  [
    "bundleId": app.bundleIdentifier ?? "",
    "name": app.localizedName ?? "",
    "pid": app.processIdentifier,
    "hidden": app.isHidden,
    "regular": app.activationPolicy == .regular,
  ]
}

func frontmost() -> JSON? {
  NSWorkspace.shared.frontmostApplication.map(describe)
}

func running() -> [JSON] {
  NSWorkspace.shared.runningApplications.map(describe)
}

/// The app that owns the UI element under a point: the one a click there
/// would reach. Window bounds cannot answer this, because the Dock keeps a
/// transparent full-screen window above everything that clicks pass through.
///
/// An app that is busy (a web view mid-load, say) can fail to answer the
/// accessibility query, so that falls back to the topmost real window.
func ownerAt(x: Double, y: Double) -> JSON {
  for attempt in 0..<2 {
    var element: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &element)
    if err == .success, let element { return describe(element: element) }
    if attempt == 0 { pause(60) }
  }
  return windowOwnerAt(CGPoint(x: x, y: y))
}

/// The element that has keyboard focus, which is where typing lands.
func focused() -> JSON? {
  var value: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(
    AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &value)
  guard err == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  let element = value as! AXUIElement
  var out = describe(element: element)
  // What an edit at the caret would touch: the selection and the text either
  // side of it, so a Delete can be described by the text it removes. Never
  // for a password field.
  if !(out["secure"] as? Bool ?? false), let range = selectedRange(element) {
    let total = attribute(element, kAXNumberOfCharactersAttribute) as? Int ?? Int.max
    let end = range.location + range.length
    let before = max(0, range.location - EDIT_CONTEXT)
    out["selection"] = ["location": range.location, "length": range.length]
    out["selectedText"] =
      range.length > 0 ? stringFor(element, location: range.location, length: min(range.length, 4000)) ?? "" : ""
    out["textAfter"] = stringFor(element, location: end, length: max(0, min(EDIT_CONTEXT, total - end))) ?? ""
    out["textBefore"] = stringFor(element, location: before, length: range.location - before) ?? ""
  }
  return out
}

/// How much text either side of the caret `focused` reports.
let EDIT_CONTEXT = 1000

func selectedRange(_ element: AXUIElement) -> CFRange? {
  guard let v = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID()
  else { return nil }
  var range = CFRange()
  return AXValueGetValue(v as! AXValue, .cfRange, &range) ? range : nil
}

func stringFor(_ element: AXUIElement, location: Int, length: Int) -> String? {
  if length <= 0 { return "" }
  var range = CFRange(location: location, length: length)
  guard let param = AXValueCreate(.cfRange, &range) else { return nil }
  var out: CFTypeRef?
  let err = AXUIElementCopyParameterizedAttributeValue(
    element, kAXStringForRangeParameterizedAttribute as CFString, param, &out)
  return err == .success ? out as? String : nil
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

/// A short readable label: the first of title, description, placeholder and
/// help that is set. Values are clipped; a text area's value can be a book.
func text(_ element: AXUIElement, _ name: String, limit: Int = 80) -> String {
  guard let s = attribute(element, name) as? String, !s.isEmpty else { return "" }
  return s.count > limit ? String(s.prefix(limit)) + "…" : s
}

/// Who owns an element and what it is: enough for a person, or a classifier,
/// to know what a click or keystroke there would do.
func describe(element: AXUIElement) -> JSON {
  var pid: pid_t = 0
  AXUIElementGetPid(element, &pid)
  let role = text(element, kAXRoleAttribute)
  let subrole = text(element, kAXSubroleAttribute)
  let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXHelpAttribute]
    .map { text(element, $0) }.first { !$0.isEmpty } ?? ""
  let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
  var window = ""
  if let w = attribute(element, kAXWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
    window = text(w as! AXUIElement, kAXTitleAttribute)
  }
  var out = owner(pid: pid, role: role, via: "accessibility")
  out["identifier"] = text(element, "AXIdentifier")
  out["ancestors"] = ancestorIds(element)
  out["subrole"] = subrole
  out["label"] = label
  out["value"] = secure ? "" : text(element, kAXValueAttribute)
  out["window"] = window
  out["secure"] = secure
  return out
}

/// Identifiers of the element's ancestors, nearest first: enough to tell a
/// row in a sidebar from the same text in a document.
func ancestorIds(_ element: AXUIElement) -> [String] {
  var ids: [String] = []
  var current = element
  for _ in 0..<12 {
    guard let parent = attribute(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID()
    else { break }
    current = parent as! AXUIElement
    let id = text(current, "AXIdentifier")
    if !id.isEmpty { ids.append(id) }
  }
  return ids
}

func frame(_ element: AXUIElement) -> JSON? {
  var point = CGPoint.zero
  var size = CGSize.zero
  guard let p = attribute(element, kAXPositionAttribute), let z = attribute(element, kAXSizeAttribute),
    AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(z as! AXValue, .cgSize, &size)
  else { return nil }
  return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

/// The first text inside an element: a static text's value, or failing that
/// any description. Rows in lists keep their title there.
func firstText(_ element: AXUIElement, depth: Int = 0) -> String {
  if text(element, kAXRoleAttribute) == "AXStaticText" {
    let v = text(element, kAXValueAttribute, limit: 200)
    if !v.isEmpty { return v }
    let d = text(element, kAXDescriptionAttribute, limit: 200)
    if !d.isEmpty { return d }
  }
  guard depth < 5 else { return "" }
  for child in children(element) {
    let t = firstText(child, depth: depth + 1)
    if !t.isEmpty { return t }
  }
  return ""
}

/// An app's windows, front first, and in each the elements with the given
/// identifiers: each one's frame, value, and rows (its children, each with
/// its first text). This is how the server knows which conversation or note
/// is open and where the lists are, without reading pixels.
func inspect(_ req: JSON) throws -> JSON {
  let bundleId = try str(req, "bundleId")
  let wanted = Set(req["ids"] as? [String] ?? [])
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    return ["running": false, "windows": []]
  }
  let ax = AXUIElementCreateApplication(app.processIdentifier)
  let windows = attribute(ax, kAXWindowsAttribute) as? [AXUIElement] ?? []
  return ["running": true, "windows": windows.map { inspectWindow($0, wanted) }]
}

func inspectWindow(_ window: AXUIElement, _ wanted: Set<String>) -> JSON {
  var found: [String: JSON] = [:]
  var queue: [(AXUIElement, Int)] = [(window, 0)]
  while !queue.isEmpty, found.count < wanted.count {
    let (element, depth) = queue.removeFirst()
    let id = text(element, "AXIdentifier")
    if wanted.contains(id), found[id] == nil {
      var rows: [JSON] = []
      for child in children(element).prefix(200) {
        guard let f = frame(child) else { continue }
        rows.append(["text": firstText(child), "frame": f])
      }
      var entry: JSON = ["value": text(element, kAXValueAttribute, limit: 400), "rows": rows]
      if let f = frame(element) { entry["frame"] = f }
      found[id] = entry
    }
    if depth < 14 { queue.append(contentsOf: children(element).map { ($0, depth + 1) }) }
  }
  var out: JSON = ["title": text(window, kAXTitleAttribute, limit: 200), "found": found]
  if let f = frame(window) { out["frame"] = f }
  return out
}

func owner(pid: pid_t, role: String, via: String) -> JSON {
  let app = NSRunningApplication(processIdentifier: pid)
  return [
    "pid": pid, "bundleId": app?.bundleIdentifier ?? "", "name": app?.localizedName ?? "",
    "role": role, "via": via,
  ]
}

/// The owner of the topmost window under a point, skipping the Dock's
/// full-screen overlay. Nothing there means the desktop, which Finder owns.
func windowOwnerAt(_ point: CGPoint) -> JSON {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [JSON] ?? []
  let screens = activeDisplays().map(CGDisplayBounds)
  for w in list {
    guard let dict = w[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: dict), bounds.contains(point)
    else { continue }
    if (w[kCGWindowAlpha as String] as? Double ?? 1) <= 0 { continue }
    let ownerName = w[kCGWindowOwnerName as String] as? String ?? ""
    if ownerName == "Dock" && screens.contains(bounds) { continue }
    let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
    return owner(pid: pid, role: "", via: "windows")
  }
  let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first
  return owner(pid: finder?.processIdentifier ?? 0, role: "desktop", via: "windows")
}

/// Whether macOS lets this process tree capture the screen and post input,
/// and whether the session is locked (input would reach the login window).
func permissions() -> JSON {
  let session = CGSessionCopyCurrentDictionary() as? JSON
  return [
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "accessibility": AXIsProcessTrusted(),
    "locked": session?["CGSSessionScreenIsLocked"] as? Bool ?? false,
  ]
}

func hide(_ bundleIds: [String]) -> [String] {
  var hidden: [String] = []
  for app in NSWorkspace.shared.runningApplications
  where app.activationPolicy == .regular && !app.isHidden
    && bundleIds.contains(app.bundleIdentifier ?? "")
  {
    if app.hide() { hidden.append(app.localizedName ?? app.bundleIdentifier ?? "?") }
  }
  return hidden
}

/// Every .app in the usual install locations, one level deep plus Utilities.
func installedApps() -> [JSON] {
  let fm = FileManager.default
  let roots = [
    "/Applications", "/Applications/Utilities", "/System/Applications",
    "/System/Applications/Utilities", "/System/Library/CoreServices",
    NSHomeDirectory() + "/Applications",
  ]
  var seen = Set<String>()
  var out: [JSON] = []
  for root in roots {
    guard let names = try? fm.contentsOfDirectory(atPath: root) else { continue }
    for name in names.sorted() where name.hasSuffix(".app") {
      let path = root + "/" + name
      guard let bundle = Bundle(path: path), let id = bundle.bundleIdentifier, !seen.contains(id)
      else { continue }
      seen.insert(id)
      let display =
        bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
        ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
        ?? String(name.dropLast(4))
      out.append(["bundleId": id, "name": String(name.dropLast(4)), "displayName": display, "path": path])
    }
  }
  return out
}

@MainActor
func open(bundleId: String) async throws -> JSON {
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
    throw HelperError("no application with bundle id \(bundleId)")
  }
  let config = NSWorkspace.OpenConfiguration()
  config.activates = true
  let app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
  app.activate()
  return describe(app)
}

/// Quits these exact processes, each only while it is still the app it was
/// (pids are reused), and waits for them to exit. Nothing is force-quit: an
/// app that stops to ask about unsaved work stays open and is reported.
@MainActor
func quit(_ req: JSON) async throws -> JSON {
  var targets: [NSRunningApplication] = []
  for entry in req["apps"] as? [JSON] ?? [] {
    guard let pid = entry["pid"] as? Int, let bundleId = entry["bundleId"] as? String,
      let app = NSRunningApplication(processIdentifier: pid_t(pid)),
      app.bundleIdentifier == bundleId, !app.isTerminated
    else { continue }
    app.terminate()
    targets.append(app)
  }
  let deadline = Date().addingTimeInterval((req["timeoutMs"] as? Double ?? 5000) / 1000)
  while Date() < deadline && targets.contains(where: { !$0.isTerminated }) {
    try await Task.sleep(nanoseconds: 100_000_000)
  }
  let name = { (a: NSRunningApplication) in a.localizedName ?? a.bundleIdentifier ?? "?" }
  return [
    "quit": targets.filter { $0.isTerminated }.map(name),
    "stillOpen": targets.filter { !$0.isTerminated }.map(name),
  ]
}

// MARK: - Screen capture

@MainActor
func capture(_ req: JSON) async throws -> JSON {
  let displayId = CGDirectDisplayID(try num(req, "display"))
  let exclude = Set(req["exclude"] as? [String] ?? [])
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
    throw HelperError("display \(displayId) is not available to capture")
  }
  // `include` captures only those apps' windows, over black: nothing else on
  // the screen, not even a notification banner, can reach the image.
  let filter: SCContentFilter
  if let include = req["include"] as? [String] {
    let apps = content.applications.filter { include.contains($0.bundleIdentifier) }
    filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
  } else {
    let excluded = content.applications.filter { exclude.contains($0.bundleIdentifier) }
    filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
  }
  let config = SCStreamConfiguration()
  config.width = Int(try num(req, "width"))
  config.height = Int(try num(req, "height"))
  config.showsCursor = false
  if let r = req["rect"] as? JSON {
    config.sourceRect = CGRect(
      x: try num(r, "x"), y: try num(r, "y"), width: try num(r, "width"), height: try num(r, "height"))
  } else {
    // Always the whole display. Left unset, a filter that includes only some
    // apps captures just the box around their windows, stretched to fill the
    // image (macOS 26): the windows then sit nowhere near where the
    // redactions and the click coordinates put them.
    config.sourceRect = CGRect(x: 0, y: 0, width: CGFloat(display.width), height: CGFloat(display.height))
  }
  // ScreenCaptureKit refuses a filter with nothing on screen in it (only
  // hidden apps, say), so that capture is simply black.
  let showsSomething =
    (req["include"] as? [String]).map { include in
      content.windows.contains { w in
        w.isOnScreen && include.contains(w.owningApplication?.bundleIdentifier ?? "")
      }
    } ?? true
  var image =
    showsSomething
    ? try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    : try blank(width: config.width, height: config.height)
  if let rects = req["redact"] as? [JSON], !rects.isEmpty {
    // Redactions arrive in global points; the image covers `source` (the
    // display, or the zoom rect within it) at its own pixel size.
    let bounds = CGDisplayBounds(displayId)
    let source = config.sourceRect.isEmpty
      ? CGRect(origin: .zero, size: bounds.size) : config.sourceRect
    image = try blackOut(
      image,
      rects.map { r in
        CGRect(
          x: ((r["x"] as? Double ?? 0) - bounds.origin.x - source.origin.x) * Double(image.width) / source.width,
          y: ((r["y"] as? Double ?? 0) - bounds.origin.y - source.origin.y) * Double(image.height) / source.height,
          width: (r["width"] as? Double ?? 0) * Double(image.width) / source.width,
          height: (r["height"] as? Double ?? 0) * Double(image.height) / source.height)
      })
  }
  let data = NSMutableData()
  guard
    let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
  else { throw HelperError("could not create a JPEG encoder") }
  let quality = (req["quality"] as? NSNumber)?.doubleValue ?? 0.85
  CGImageDestinationAddImage(
    dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { throw HelperError("JPEG encoding failed") }
  return [
    "data": (data as Data).base64EncodedString(), "width": image.width, "height": image.height,
  ]
}

/// A black image, for a capture that has nothing it may show.
func blank(width: Int, height: Int) throws -> CGImage {
  guard
    let ctx = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw HelperError("could not make an empty capture") }
  ctx.setFillColor(CGColor(gray: 0, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  guard let image = ctx.makeImage() else { throw HelperError("could not make an empty capture") }
  return image
}

/// The image with the given pixel rectangles (top-left origin) painted black.
func blackOut(_ image: CGImage, _ rects: [CGRect]) throws -> CGImage {
  guard
    let ctx = CGContext(
      data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw HelperError("could not redact the capture") }
  let h = CGFloat(image.height)
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  ctx.setFillColor(CGColor(gray: 0, alpha: 1))
  for r in rects {
    // Core Graphics draws from the bottom-left.
    ctx.fill(CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height))
  }
  guard let out = ctx.makeImage() else { throw HelperError("could not redact the capture") }
  return out
}

// MARK: - Input

let source = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) {
  event?.post(tap: .cghidEventTap)
}

func cursor() -> CGPoint {
  CGEvent(source: nil)?.location ?? .zero
}

func buttonTypes(_ name: String) throws -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
  switch name {
  case "left": return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
  case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
  case "middle": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
  default: throw HelperError("unknown button: \(name)")
  }
}

func mouseEvent(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton, _ f: CGEventFlags, clicks: Int = 1)
  -> CGEvent?
{
  let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: button)
  e?.flags = f
  e?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
  return e
}

/// Move there, then press and release `count` times as one multi-click.
func click(_ req: JSON) throws {
  let at = CGPoint(x: try num(req, "x"), y: try num(req, "y"))
  let (button, down, up, _) = try buttonTypes(req["button"] as? String ?? "left")
  let count = (req["count"] as? NSNumber)?.intValue ?? 1
  let f = flags(req)
  post(mouseEvent(.mouseMoved, at, button, f))
  pause(30)
  for i in 1...max(1, count) {
    post(mouseEvent(down, at, button, f, clicks: i))
    pause(15)
    post(mouseEvent(up, at, button, f, clicks: i))
    pause(40)
  }
}

/// Move the pointer. With a button held, macOS expects drag events instead.
func move(_ req: JSON) throws {
  let at = CGPoint(x: try num(req, "x"), y: try num(req, "y"))
  if let held = req["held"] as? String {
    let (button, _, _, dragged) = try buttonTypes(held)
    post(mouseEvent(dragged, at, button, flags(req)))
  } else {
    post(mouseEvent(.mouseMoved, at, .left, flags(req)))
  }
}

func button(_ req: JSON, pressed: Bool) throws {
  let (button, down, up, _) = try buttonTypes(req["button"] as? String ?? "left")
  post(mouseEvent(pressed ? down : up, cursor(), button, flags(req)))
}

/// Press at start, glide to end in small steps, release.
func drag(_ req: JSON) throws {
  let from = CGPoint(x: try num(req, "fromX"), y: try num(req, "fromY"))
  let to = CGPoint(x: try num(req, "x"), y: try num(req, "y"))
  let f = flags(req)
  post(mouseEvent(.mouseMoved, from, .left, f))
  pause(30)
  post(mouseEvent(.leftMouseDown, from, .left, f))
  pause(60)
  let steps = 12
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
    post(mouseEvent(.leftMouseDragged, p, .left, f))
    pause(12)
  }
  pause(60)
  post(mouseEvent(.leftMouseUp, to, .left, f))
}

func scroll(_ req: JSON) throws {
  let at = CGPoint(x: try num(req, "x"), y: try num(req, "y"))
  post(mouseEvent(.mouseMoved, at, .left, flags(req)))
  pause(30)
  let dx = Int32(try num(req, "dx"))
  let dy = Int32(try num(req, "dy"))
  // One event per tick: apps treat a single large delta as a fling.
  let ticks = max(abs(dx), abs(dy))
  for _ in 0..<ticks {
    let e = CGEvent(
      scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
      wheel1: dy == 0 ? 0 : (dy > 0 ? 1 : -1), wheel2: dx == 0 ? 0 : (dx > 0 ? 1 : -1), wheel3: 0)
    e?.flags = flags(req)
    post(e)
    pause(20)
  }
}

func keyEvent(_ code: CGKeyCode, _ down: Bool, _ f: CGEventFlags) -> CGEvent? {
  let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
  e?.flags = f
  return e
}

/// Press modifiers in order, then the keys, then release everything in reverse.
/// `hold` keeps the whole chord down for that many milliseconds.
func chord(_ req: JSON) throws {
  let modifiers = (req["modifiers"] as? [[NSNumber]] ?? []).map {
    (CGKeyCode($0[0].uint16Value), CGEventFlags(rawValue: $0[1].uint64Value))
  }
  let keys = (req["keys"] as? [NSNumber] ?? []).map { CGKeyCode($0.uint16Value) }
  let repeatCount = (req["repeat"] as? NSNumber)?.intValue ?? 1
  let hold = (req["hold"] as? NSNumber)?.doubleValue ?? 0
  for _ in 0..<max(1, repeatCount) {
    var f = CGEventFlags()
    for (code, mask) in modifiers {
      f.insert(mask)
      post(keyEvent(code, true, f))
    }
    for k in keys { post(keyEvent(k, true, f)) }
    pause(hold > 0 ? hold : 8)
    for k in keys.reversed() { post(keyEvent(k, false, f)) }
    for (code, mask) in modifiers.reversed() {
      f.remove(mask)
      post(keyEvent(code, false, f))
    }
    pause(repeatCount > 1 ? 25 : 8)
  }
}

/// Type Unicode text. Newlines and tabs are real key presses so that editors
/// treat them as Return and Tab rather than as inserted characters.
func typeText(_ text: String) {
  var pending = ""
  func flush() {
    let units = Array(pending.utf16)
    var i = 0
    while i < units.count {
      let chunk = Array(units[i..<min(i + 16, units.count)])
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.flags = []
        chunk.withUnsafeBufferPointer {
          e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress)
        }
        post(e)
      }
      pause(12)
      i += 16
    }
    pending = ""
  }
  for ch in text {
    if ch == "\n" || ch == "\r\n" || ch == "\t" {
      flush()
      let code: CGKeyCode = ch == "\t" ? 48 : 36
      post(keyEvent(code, true, []))
      post(keyEvent(code, false, []))
      pause(20)
    } else {
      pending.append(ch)
    }
  }
  flush()
}

// MARK: - Clipboard

func clipboardRead() -> String? { NSPasteboard.general.string(forType: .string) }

func clipboardWrite(_ text: String) {
  NSPasteboard.general.clearContents()
  NSPasteboard.general.setString(text, forType: .string)
}

// MARK: - Dispatch

@MainActor
func handle(_ req: JSON) async throws -> Any {
  switch try str(req, "cmd") {
  case "permissions": return permissions()
  case "displays": return displays()
  case "frontmost": return frontmost() ?? NSNull()
  case "running": return running()
  case "owner_at": return ownerAt(x: try num(req, "x"), y: try num(req, "y"))
  case "focused": return focused() ?? NSNull()
  case "inspect": return try inspect(req)
  case "hide": return hide(req["bundleIds"] as? [String] ?? [])
  case "installed_apps": return installedApps()
  case "open": return try await open(bundleId: try str(req, "bundleId"))
  case "quit": return try await quit(req)
  case "capture": return try await capture(req)
  case "cursor":
    let p = cursor()
    return ["x": p.x, "y": p.y]
  case "click": try click(req)
  case "move": try move(req)
  case "button_down": try button(req, pressed: true)
  case "button_up": try button(req, pressed: false)
  case "drag": try drag(req)
  case "scroll": try scroll(req)
  case "chord": try chord(req)
  case "type": typeText(try str(req, "text"))
  case "clipboard_read": return ["text": clipboardRead() as Any? ?? NSNull()]
  case "clipboard_write": clipboardWrite(try str(req, "text"))
  case let other: throw HelperError("unknown command: \(other)")
  }
  return ["done": true]
}

func reply(_ obj: JSON) {
  guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

// Requests are served one at a time, in order. The main run loop has to keep
// running: AppKit only refreshes the frontmost application and the running
// app list while it does.
DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
      let req = (try? JSONSerialization.jsonObject(with: data)) as? JSON
    else { continue }
    let id = req["id"] ?? NSNull()
    let done = DispatchSemaphore(value: 0)
    Task { @MainActor in
      do {
        reply(["id": id, "ok": true, "result": try await handle(req)])
      } catch let e as HelperError {
        reply(["id": id, "ok": false, "error": e.message])
      } catch {
        reply(["id": id, "ok": false, "error": error.localizedDescription])
      }
      done.signal()
    }
    done.wait()
  }
  exit(0)
}
RunLoop.main.run()
