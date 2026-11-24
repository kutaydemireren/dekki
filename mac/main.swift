// Dekki.app: thin launcher + window. All logic stays in server/ and web/.
// Starts `node server/start.js` from the repo checkout (or attaches to a server already answering), shows it in a WKWebView.
import Cocoa
import WebKit
import ServiceManagement
import UserNotifications

let port = Int(ProcessInfo.processInfo.environment["PORT"] ?? "") ?? 4317
let baseURL = URL(string: "http://127.0.0.1:\(port)")!
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Dekki/server-\(port).log")

func repoPath() -> String? {
    if let p = ProcessInfo.processInfo.environment["DEKKI_REPO"], !p.isEmpty { return p }
    guard let f = Bundle.main.url(forResource: "repo-path", withExtension: "txt"),
          let s = try? String(contentsOf: f, encoding: .utf8) else { return nil }
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Run a program, return stdout (nil on failure). Stdin closed.
func run(_ exe: String, _ args: [String], timeout: TimeInterval = 0) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if timeout > 0 {
        // Output goes to a temp file, not a pipe: a daemon the shell starts (ssh-agent) can keep a pipe open past the shell's exit.
        let f = FileManager.default.temporaryDirectory.appendingPathComponent("dekki-run-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: f.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: f) }
        guard let h = try? FileHandle(forWritingTo: f) else { return nil }
        p.standardOutput = h; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let end = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < end { Thread.sleep(forTimeInterval: 0.05) }
        if p.isRunning { p.terminate(); return nil }
        p.waitUntilExit()
        return p.terminationStatus == 0 ? (try? String(contentsOf: f, encoding: .utf8)) : nil
    }
    let out = Pipe()
    p.standardOutput = out; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return p.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
}

/// A server already answering as Dekki? (GET /api/config with the Origin the server expects.)
func healthy() -> Bool {
    var r = URLRequest(url: baseURL.appendingPathComponent("api/config"), timeoutInterval: 2)
    r.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: r) { data, resp, _ in
        if (resp as? HTTPURLResponse)?.statusCode == 200, let d = data,
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], j["rootReady"] != nil { ok = true }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 3)
    return ok
}

func logTail(_ n: Int = 25) -> String {
    guard let s = try? String(contentsOf: logURL, encoding: .utf8) else { return "(no server log)" }
    return s.split(separator: "\n", omittingEmptySubsequences: false).suffix(n).joined(separator: "\n")
}

func descendants(of pid: Int32) -> [Int32] {
    let kids = (run("/usr/bin/pgrep", ["-P", String(pid)]) ?? "").split(separator: "\n").compactMap { Int32($0) }
    return kids + kids.flatMap { descendants(of: $0) }
}

// Start at login. The service is injected so tests never touch the real login items (a test build would register a worktree path).
enum LoginStatus: String { case off, enabled, requiresApproval, unavailable }

struct LoginItemService {
    var status: () -> LoginStatus
    var register: () throws -> Void
    var unregister: () throws -> Void
    var openSettings: () -> Void

    static let real = LoginItemService(
        status: {
            switch SMAppService.mainApp.status {
            case .enabled: return .enabled
            case .requiresApproval: return .requiresApproval
            case .notFound: return .unavailable
            default: return .off
            }
        },
        register: { try SMAppService.mainApp.register() },
        unregister: { try SMAppService.mainApp.unregister() },
        openSettings: { SMAppService.openSystemSettingsLoginItems() })
}

/// What a click on "Start at login" does. Returns a short word for the test hook; `tell` shows a message to the user.
func toggleLoginItem(_ s: LoginItemService, tell: (String, String) -> Void) -> String {
    let approve = "Allow Dekki in System Settings > General > Login Items & Extensions, then it starts at login."
    switch s.status() {
    case .enabled:
        do { try s.unregister(); return "unregistered" } catch { tell("Could not turn off start at login", error.localizedDescription); return "error" }
    case .requiresApproval:
        tell("Start at login needs your approval", approve); s.openSettings(); return "needs-approval"
    case .off, .unavailable:
        do { try s.register() } catch { tell("Could not turn on start at login", error.localizedDescription); return "error" }
        if s.status() == .requiresApproval { tell("Start at login needs your approval", approve); s.openSettings(); return "needs-approval" }
        return s.status() == .enabled ? "registered" : "error"
    }
}

/// Menu-bar glyph: a fan of three cards, a face knocked out of the front one. A template image (black + alpha): the system tints it for light and dark menu bars.
func menuGlyph() -> NSImage {
    let img = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
        func card(_ rect: NSRect, angle: CGFloat, fill: Bool) {
            NSGraphicsContext.saveGraphicsState()
            let t = NSAffineTransform(); t.translateX(by: 10, yBy: 3); t.rotate(byDegrees: angle); t.translateX(by: -10, yBy: -3); t.concat()
            let path = NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2)
            NSColor.black.setStroke(); NSColor.black.setFill()
            path.lineWidth = 1.3
            if fill { path.fill() } else { path.stroke() }
            NSGraphicsContext.restoreGraphicsState()
        }
        card(NSRect(x: 6, y: 3, width: 8, height: 12.5), angle: 24, fill: false)
        card(NSRect(x: 6, y: 3, width: 8, height: 12.5), angle: -24, fill: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current?.compositingOperation = .clear
        NSBezierPath(roundedRect: NSRect(x: 4, y: 1, width: 12, height: 15.5), xRadius: 3.5, yRadius: 3.5).fill()   // gap around the front card
        NSGraphicsContext.restoreGraphicsState()
        card(NSRect(x: 5.5, y: 2.5, width: 9, height: 12.5), angle: 0, fill: true)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current?.compositingOperation = .clear
        NSBezierPath(ovalIn: NSRect(x: 7.4, y: 8.6, width: 1.9, height: 1.9)).fill()
        NSBezierPath(ovalIn: NSRect(x: 10.7, y: 8.6, width: 1.9, height: 1.9)).fill()
        let smile = NSBezierPath(); smile.lineWidth = 1.1; smile.lineCapStyle = .round
        smile.move(to: NSPoint(x: 7.6, y: 6.6))
        smile.curve(to: NSPoint(x: 12.4, y: 6.6), controlPoint1: NSPoint(x: 8.6, y: 4.8), controlPoint2: NSPoint(x: 11.4, y: 4.8))
        NSColor.clear.setStroke(); smile.stroke()
        NSGraphicsContext.restoreGraphicsState()
        return true
    }
    img.isTemplate = true
    return img
}

/// Launched by macOS as a login item? The open-application Apple Event carries keyAELaunchedAsLogInItem (read in applicationDidFinishLaunching).
func launchedAsLoginItem() -> Bool {
    guard let e = NSAppleEventManager.shared().currentAppleEvent, e.eventID == AEEventID(kAEOpenApplication) else { return false }
    return e.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
}

// Native notifications. The server (server/notify.js) decides which agents notify and when, and what the text is; this only
// shows what the server sends over GET /api/app/events. While this stream is connected the server sends no OS banner itself.
struct NotifyEvent { let thread: String; let title: String; let body: String; let hash: String? }
enum NotifAuth { case notDetermined, authorized, denied }

/// UNUserNotificationCenter behind a seam, so tests drive the same logic without a permission prompt or a real banner.
struct NotifyCenter {
    var status: (@escaping (NotifAuth) -> Void) -> Void
    var request: (UNAuthorizationOptions, @escaping (Bool) -> Void) -> Void
    var badgeDisabled: (@escaping (Bool) -> Void) -> Void   // "Badge app icon" is off in System Settings > Notifications
    var post: (NotifyEvent) -> Void
    /// The Dock badge needs the "Badge app icon" notification setting, which only exists if the app asked for .badge.
    static let options: UNAuthorizationOptions = [.alert, .badge]
    static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!

    static let real = NotifyCenter(
        status: { cb in UNUserNotificationCenter.current().getNotificationSettings { s in
            cb(s.authorizationStatus == .denied ? .denied : s.authorizationStatus == .notDetermined ? .notDetermined : .authorized) } },
        request: { o, cb in UNUserNotificationCenter.current().requestAuthorization(options: o) { granted, _ in cb(granted) } },
        badgeDisabled: { cb in UNUserNotificationCenter.current().getNotificationSettings { s in cb(s.badgeSetting == .disabled) } },
        post: { n in
            let c = UNMutableNotificationContent()
            c.title = n.title; c.body = n.body; c.threadIdentifier = n.thread
            if let h = n.hash { c.userInfo = ["hash": h] }
            // Same identifier = a newer notification for the same agent replaces the older one.
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: n.thread, content: c, trigger: nil))
        })
}

/// Server-sent events client for GET /api/app/events (Origin header like the other loopback calls). Reconnects are driven by the app's timer.
final class EventStream: NSObject, URLSessionDataDelegate {
    var onEvent: (([String: Any]) -> Void)?
    private(set) var connected = false      // true after the server's hello
    private var task: URLSessionDataTask?
    private var raw = Data()
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 90    // the server pings every 20 s; silence for 90 s means a dead connection
        return URLSession(configuration: c, delegate: self, delegateQueue: .main)
    }()
    var running: Bool { task != nil }
    func start() {
        guard task == nil else { return }
        var r = URLRequest(url: baseURL.appendingPathComponent("api/app/events"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        r.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
        r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        raw = Data(); task = session.dataTask(with: r); task?.resume()
    }
    func stop() { task?.cancel(); task = nil; connected = false; raw = Data() }
    func urlSession(_ s: URLSession, dataTask t: URLSessionDataTask, didReceive resp: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler((resp as? HTTPURLResponse)?.statusCode == 200 ? .allow : .cancel)   // e.g. an older server without the route
    }
    func urlSession(_ s: URLSession, dataTask t: URLSessionDataTask, didReceive data: Data) {
        guard t === task else { return }
        raw.append(data)
        let sep = Data("\n\n".utf8)
        while let r = raw.range(of: sep) {
            let block = String(decoding: raw.subdata(in: raw.startIndex..<r.lowerBound), as: UTF8.self)
            raw.removeSubrange(raw.startIndex..<r.upperBound)
            var event = "message", payload = ""
            for line in block.split(separator: "\n") {
                if line.hasPrefix("event:") { event = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
                else if line.hasPrefix("data:") { payload += line.dropFirst(5).trimmingCharacters(in: .whitespaces) }
            }
            if event == "hello" { connected = true }
            else if event == "notify", let j = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] { onEvent?(j) }
        }
    }
    func urlSession(_ s: URLSession, task t: URLSessionTask, didCompleteWithError e: Error?) {
        if t === task { task = nil; connected = false }
    }
}

/// A WKWebView has no CSS drag region, so the top strip (the height the page leaves free: web/styles/motion.css, Mac-only rules) drags the window.
/// Everything below it goes to the page as usual. Double-click on the strip zooms like a title bar.
final class DragStripWebView: WKWebView {
    static let stripHeight: CGFloat = 20
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let fromTop = isFlipped ? p.y : bounds.height - p.y
        if fromTop < DragStripWebView.stripHeight, let w = window {
            if event.clickCount == 2 { w.performZoom(nil) } else { w.performDrag(with: event) }
            return
        }
        super.mouseDown(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?          // only set when WE started it
    let testDir = ProcessInfo.processInfo.environment["DEKKI_APP_TEST"]
    var statusItem: NSStatusItem!
    var attentionItem: NSMenuItem!
    var loginMenuItem: NSMenuItem!
    var attentionCount = 0
    var attentionTimer: Timer?
    let stream = EventStream()
    var center = NotifyCenter.real
    var testAuth: NotifAuth = .notDetermined      // test hook only: the fake notification center
    var testPosted: [String] = []                  // test hook only: what would have been posted
    var testBadgeOff = false                       // test hook only: fake "Badge app icon" setting is off
    var testRequestOptions = ""                    // test hook only: options the app asked authorization for
    var testOpened: [String] = []                  // test hook only: URLs the app would have opened
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    var badgeHintItem: NSMenuItem!
    var login = LoginItemService.real
    var testAlerts: [String] = []   // test hook only: what would have been shown to the user
    var testLogin: (status: LoginStatus, calls: [String], next: LoginStatus) = (.off, [], .enabled)
    var signalSources: [DispatchSourceSignal] = []
    var frameName: String { port == 4317 ? "main" : "main\(port)" }

    func applicationDidFinishLaunching(_ n: Notification) {
        // Started by macOS as a login item: keep the window hidden (server and menu-bar item still run); a Dock click or the menu shows it.
        let startHidden = testDir != nil ? ProcessInfo.processInfo.environment["DEKKI_TEST_LOGIN_LAUNCH"] == "1" : launchedAsLoginItem()
        if testDir != nil { useFakeLoginItem(); useFakeNotifyCenter(); openURL = { self.testOpened.append($0.absoluteString) } }   // tests never register a login item or post a banner
        buildMenu()
        buildStatusItem()
        // The page recognises the Mac app by this user-agent suffix (web/index.html) and adds top padding for the traffic lights.
        let webConfig = WKWebViewConfiguration()
        webConfig.applicationNameForUserAgent = "DekkiMac"
        web = DragStripWebView(frame: .zero, configuration: webConfig)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Dekki"
        window.titlebarAppearsTransparent = true   // the sidebar runs to the top edge, traffic lights sit on it
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false   // Cmd+W only hides it: web view, page state and frame stay for reopen
        window.contentView = web
        if !window.setFrameUsingName(frameName) { window.center() }
        window.setFrameAutosaveName(frameName)
        if !startHidden { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        showMessage("Starting Dekki…", detail: "")
        DispatchQueue.global().async { self.startup() }
        if testDir != nil { startTestHook() }
        startNotifications()
        attentionTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in self.pollAttention() }
        pollAttention()
        for s in [SIGTERM, SIGINT] {
            signal(s, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: s, queue: .main)
            src.setEventHandler { NSApp.terminate(nil) }
            src.resume()
            signalSources.append(src)
        }
    }

    func startup() {
        if healthy() { load(); return }   // attach: not ours, never killed
        guard let repo = repoPath(), FileManager.default.fileExists(atPath: repo + "/server/start.js") else {
            return fail("Dekki checkout not found.", "Expected server/start.js in: \(repoPath() ?? "(no repo-path.txt in the app, set DEKKI_REPO)")\nRebuild with mac/build.sh from the checkout.")
        }
        // PATH from a login shell (Finder launches get a minimal PATH). Markers skip rc-file noise; braces matter (zsh reads $PATH__P__ as one name); 10 s timeout.
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let raw = run(shell, ["-lic", "echo __P__${PATH}__P__"], timeout: 10) ?? ""
        var path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        if let a = raw.range(of: "__P__"), let b = raw.range(of: "__P__", range: a.upperBound..<raw.endIndex) { path = String(raw[a.upperBound..<b.lowerBound]) }
        func find(_ name: String) -> String? {
            for d in path.split(separator: ":") { let f = "\(d)/\(name)"; if FileManager.default.isExecutableFile(atPath: f) { return f } }
            return nil
        }
        guard let node = find("node") else { return fail("node not found.", "Searched the PATH of a login shell (\(shell)):\n\(path)\nInstall Node >= 22.") }
        let ver = (run(node, ["-p", "process.versions.node"]) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let major = Int(ver.split(separator: ".").first ?? ""), major >= 22 else { return fail("node >= 22 needed.", "\(node) is version \(ver.isEmpty ? "unknown" : ver).") }
        guard find("claude") != nil else { return fail("claude not found.", "Searched the PATH of a login shell (\(shell)):\n\(path)\nInstall Claude Code.") }

        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        guard let log = try? FileHandle(forWritingTo: logURL) else { return fail("Cannot write server log.", logURL.path) }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        env["PORT"] = String(port)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["server/start.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: repo)
        p.environment = env
        p.standardOutput = log; p.standardError = log; p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return fail("Could not start node.", "\(error)") }
        server = p
        for _ in 0..<120 {    // up to 60 s (first start may build dist/)
            if healthy() { load(); return }
            if !p.isRunning { return fail("Server exited (status \(p.terminationStatus)).", logTail()) }
            Thread.sleep(forTimeInterval: 0.5)
        }
        fail("Server did not answer within 60 s.", logTail())
    }

    func load() { DispatchQueue.main.async { self.web.load(URLRequest(url: baseURL)) } }
    func fail(_ title: String, _ detail: String) { DispatchQueue.main.async { self.showMessage(title, detail: detail) } }

    func showMessage(_ title: String, detail: String) {
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        web.loadHTMLString("<body style='font:14px -apple-system;background:#1e1e1e;color:#ddd;padding:32px'><h2>\(esc(title))</h2><pre style='white-space:pre-wrap;color:#aaa'>\(esc(detail))</pre>", baseURL: nil)
    }

    // Quit: stop the server only if we started it; then make sure nothing it spawned stays behind.
    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        guard let p = server, p.isRunning else { return .terminateNow }
        let kids = descendants(of: p.processIdentifier)
        p.terminate()
        for _ in 0..<50 where p.isRunning { Thread.sleep(forTimeInterval: 0.1) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        for k in kids where kill(k, 0) == 0 { kill(k, SIGTERM) }
        Thread.sleep(forTimeInterval: 0.3)
        for k in kids where kill(k, 0) == 0 { kill(k, SIGKILL) }
        return .terminateNow
    }
    // Closing the window keeps the app (and the server) running; Dock click / reopen / Window menu brings it back.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(nil); return true }
    @objc func closeWindow(_ s: Any?) { window.performClose(nil) }   // targets our window even when the app is not active
    @objc func showWindow(_ s: Any?) {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Menu-bar item: Show Dekki, agents needing input (when > 0), Start at login, Quit. The Dock icon stays (regular app).
    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = menuGlyph()
        statusItem.button?.imagePosition = .imageLeft
        statusItem.button?.toolTip = "Dekki"
        let m = NSMenu(); m.delegate = self
        func item(_ title: String, _ sel: Selector, _ target: AnyObject) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: ""); i.target = target; m.addItem(i); return i
        }
        _ = item("Show Dekki", #selector(showWindow(_:)), self)
        attentionItem = item("", #selector(showWindow(_:)), self)
        m.addItem(.separator())
        badgeHintItem = item("Enable Badge app icon in System Settings > Notifications", #selector(openNotificationSettings(_:)), self)
        badgeHintItem.isHidden = true
        loginMenuItem = item("Start at login", #selector(toggleLogin(_:)), self)
        m.addItem(.separator())
        _ = item("Quit Dekki", #selector(NSApplication.terminate(_:)), NSApp)
        statusItem.menu = m
        setAttention(0)
        refreshLoginItem()
    }
    func menuWillOpen(_ menu: NSMenu) { refreshLoginItem(); refreshBadgeHint() }   // the user may have changed either in System Settings
    @objc func openNotificationSettings(_ s: Any?) { openURL(NotifyCenter.settingsURL) }
    /// Hint shown only when notifications are allowed but "Badge app icon" is off and something waits: the Dock badge cannot show then.
    func refreshBadgeHint() {
        center.status { st in self.center.badgeDisabled { off in
            let apply = { self.badgeHintItem.isHidden = !(st == .authorized && off && self.attentionCount > 0) }
            if Thread.isMainThread { apply() } else { DispatchQueue.main.async { apply() } }
        } }
    }

    /// Number of agents needing input: menu line and the number next to the glyph.
    func setAttention(_ n: Int) {
        let old = attentionCount
        attentionCount = n
        attentionItem.isHidden = n == 0
        attentionItem.title = n == 1 ? "1 agent needs input" : "\(n) agents need input"
        statusItem.button?.title = n > 0 ? " \(n)" : ""
        if n == 0 { badgeHintItem?.isHidden = true } else if n != old { refreshBadgeHint() }
    }

    /// Agents needing input, computed by the server (the notify poller; GET /api/attention). The shell only reads it, so it does not
    /// depend on the page in a hidden window. A server that does not answer counts as 0 (a stale number is worse than none).
    func pollAttention(done: (() -> Void)? = nil) {
        var r = URLRequest(url: baseURL.appendingPathComponent("api/attention"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        r.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
        URLSession.shared.dataTask(with: r) { data, resp, _ in
            var n = 0
            if (resp as? HTTPURLResponse)?.statusCode == 200, let d = data,
               let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let c = j["count"] as? Int { n = max(0, c) }
            DispatchQueue.main.async { self.applyAttention(n); done?() }
        }.resume()
    }
    func applyAttention(_ n: Int) {
        NSApp.dockTile.badgeLabel = n > 0 ? (n > 99 ? "99+" : String(n)) : ""   // empty clears the badge
        setAttention(n)
    }

    // Notifications from the server's event stream. The permission is asked at first use (the first event), never at launch.
    func startNotifications() {
        if testDir == nil { UNUserNotificationCenter.current().delegate = self }
        stream.onEvent = { [weak self] j in self?.handleNotify(j) }
        syncSubscription()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.syncSubscription() }
    }
    /// Subscribed = the server sends no OS banner. If the user denied notifications for this app, stay unsubscribed so the
    /// server's own path (terminal-notifier / osascript) keeps working instead of events vanishing.
    func syncSubscription() {
        center.status { st in DispatchQueue.main.async { if st == .denied { self.stream.stop() } else { self.stream.start() } } }
    }
    func handleNotify(_ j: [String: Any]) {
        guard let title = j["title"] as? String, let body = j["body"] as? String else { return }
        let id = j["id"] as? String ?? "?", acct = j["accountId"] as? String
        present(NotifyEvent(thread: "dekki-\(acct.map { $0 + "-" } ?? "")\(id)", title: title, body: body, hash: j["hash"] as? String))
    }
    func present(_ n: NotifyEvent) {
        center.status { st in DispatchQueue.main.async {
            switch st {
            case .authorized: self.center.post(n)
            case .notDetermined:
                self.center.request(NotifyCenter.options) { granted in DispatchQueue.main.async { if granted { self.center.post(n) }; self.syncSubscription() } }
            case .denied: self.syncSubscription()
            }
        } }
    }
    /// A notification click: show the window and let the page's own hash routing (web/hash.js, account-aware) open the agent.
    func openHash(_ h: String?) {
        showWindow(nil)
        guard let h = h, h.range(of: "^#([a-z0-9][a-z0-9-]{0,31}:)?[0-9a-f]{8}(/history)?$", options: .regularExpression) != nil else { return }
        if web.url?.scheme == "http" {
            web.callAsyncJavaScript("location.hash = h", arguments: ["h": h], in: nil, in: .page) { _ in }
        } else if let u = URL(string: baseURL.absoluteString + "/" + h) { web.load(URLRequest(url: u)) }   // error page showing: load the deck at the link
    }
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) { h([.banner]) }
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler h: @escaping () -> Void) {
        let hash = r.notification.request.content.userInfo["hash"] as? String
        DispatchQueue.main.async { self.openHash(hash) }
        h()
    }
    /// Test seam: authorization in memory (the first request is granted), posts recorded as "post|title|body|hash|thread".
    func useFakeNotifyCenter() {
        center = NotifyCenter(
            status: { cb in cb(self.testAuth) },
            request: { o, cb in
                self.testPosted.append("auth-request")
                self.testRequestOptions = [o.contains(.alert) ? "alert" : nil, o.contains(.badge) ? "badge" : nil, o.contains(.sound) ? "sound" : nil].compactMap { $0 }.joined(separator: ",")
                self.testAuth = .authorized; cb(true) },
            badgeDisabled: { cb in cb(self.testBadgeOff) },
            post: { n in self.testPosted.append("post|\(n.title)|\(n.body)|\(n.hash ?? "")|\(n.thread)") })
    }

    func refreshLoginItem() {
        switch login.status() {
        case .enabled: loginMenuItem.state = .on; loginMenuItem.title = "Start at login"
        case .requiresApproval: loginMenuItem.state = .mixed; loginMenuItem.title = "Start at login (needs approval)"
        default: loginMenuItem.state = .off; loginMenuItem.title = "Start at login"
        }
    }
    @objc func toggleLogin(_ s: Any?) { _ = doToggleLogin() }
    @discardableResult func doToggleLogin() -> String {
        let r = toggleLoginItem(login) { title, text in
            if self.testDir != nil { self.testAlerts.append(title); return }
            let a = NSAlert(); a.messageText = title; a.informativeText = text; a.runModal()
        }
        refreshLoginItem()
        return r
    }
    /// Test seam: an in-memory login item. register() ends in `testLogin.next` (default enabled) and records the call.
    func useFakeLoginItem() {
        login = LoginItemService(
            status: { self.testLogin.status },
            register: { self.testLogin.calls.append("register"); self.testLogin.status = self.testLogin.next },
            unregister: { self.testLogin.calls.append("unregister"); self.testLogin.status = .off },
            openSettings: { self.testLogin.calls.append("openSettings") })
    }

    // Links: same origin stays, everything else goes to the default browser.
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.scheme == "http" || u.scheme == "https", !(u.host == "127.0.0.1" && u.port == port) {
            NSWorkspace.shared.open(u); decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url, u.scheme == "http" || u.scheme == "https" { NSWorkspace.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let o = NSOpenPanel()
        o.allowsMultipleSelection = p.allowsMultipleSelection
        o.canChooseDirectories = p.allowsDirectories
        o.beginSheetModal(for: window) { completionHandler($0 == .OK ? o.urls : nil) }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
    }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { window.makeFirstResponder(web) }   // menu Edit actions reach the page
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { retryLater() }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { retryLater() }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }
    func retryLater() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { if self.web.url?.scheme != "http" { self.web.load(URLRequest(url: baseURL)) } }
    }

    // View menu
    @objc func reload(_ s: Any?) { if web.url?.scheme == "http" { web.reload() } else { web.load(URLRequest(url: baseURL)) } }
    @objc func zoomIn(_ s: Any?) { web.pageZoom = min(web.pageZoom + 0.1, 3) }
    @objc func zoomOut(_ s: Any?) { web.pageZoom = max(web.pageZoom - 0.1, 0.5) }
    @objc func zoomReset(_ s: Any?) { web.pageZoom = 1 }

    func buildMenu() {
        let main = NSMenu()
        func add(_ m: NSMenu, _ title: String, _ sel: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            if let t = target { i.target = t }
            m.addItem(i)
        }
        func sub(_ title: String, _ build: (NSMenu) -> Void) {
            let item = NSMenuItem(); let m = NSMenu(title: title); build(m); item.submenu = m; main.addItem(item)
        }
        sub("Dekki") { m in
            add(m, "About Dekki", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
            m.addItem(.separator())
            add(m, "Hide Dekki", #selector(NSApplication.hide(_:)), "h")
            add(m, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
            m.addItem(.separator())
            add(m, "Quit Dekki", #selector(NSApplication.terminate(_:)), "q")
        }
        sub("Edit") { m in
            add(m, "Undo", Selector(("undo:")), "z")
            add(m, "Redo", Selector(("redo:")), "z", [.command, .shift])
            m.addItem(.separator())
            add(m, "Cut", #selector(NSText.cut(_:)), "x")
            add(m, "Copy", #selector(NSText.copy(_:)), "c")
            add(m, "Paste", #selector(NSText.paste(_:)), "v")
            add(m, "Select All", #selector(NSText.selectAll(_:)), "a")
        }
        sub("View") { m in
            add(m, "Reload", #selector(reload(_:)), "r", target: self)
            add(m, "Actual Size", #selector(zoomReset(_:)), "0", target: self)
            add(m, "Zoom In", #selector(zoomIn(_:)), "+", target: self)
            let alt = NSMenuItem(title: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "=")   // Cmd+= without shift
            alt.target = self; alt.isHidden = true; m.addItem(alt)
            add(m, "Zoom Out", #selector(zoomOut(_:)), "-", target: self)
        }
        sub("Window") { m in
            add(m, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
            add(m, "Close", #selector(closeWindow(_:)), "w", target: self)   // closes the window only; the app keeps running
            add(m, "Show Dekki", #selector(showWindow(_:)), target: self)
        }
        NSApp.mainMenu = main
    }

    // Test seam, only active with DEKKI_APP_TEST=<dir>: polls <dir>/cmd (one line), writes <dir>/out.
    //   js <code>         run JS in the page (function body, use `return`), result to out
    //   snap <file.png>   snapshot of the web view (in-process, needs no screen-recording permission)
    //   key <c|v|a|r|0|-> send Cmd+<key> through the main menu (the real key-equivalent path)
    //   win               window frame / title
    //   reopen            same as a Dock click (applicationShouldHandleReopen)
    //   menu <title>      perform a Window-menu item by title
    //   status-menu       the menu-bar menu: one line per visible item "title|state"; plus image info
    //   status-click <t>  perform a menu-bar menu item by title
    //   status-shot <f>   menu-bar glyph on light and dark backgrounds, PNG
    //   poll              fetch /api/attention now and apply it (like the 3 s timer); answers after it is applied
    //   badge             the Dock badge label
    //   events            event stream: connected flag, and what the fake notification center was asked to do
    //   notif-auth <s>    fake notification authorization (notDetermined|authorized|denied); re-syncs the subscription
    //   notif-badge <on|off>   fake "Badge app icon" setting (off = disabled); notif-options = options the app requested
    //   notif-reset       forget recorded posts and set the fake authorization back to notDetermined
    //   notif-click <h>   same as clicking a notification with link hash <h> (e.g. #default:ab12cd34)
    //   login             fake login item: status, recorded calls, alerts that would have been shown
    //   login-set <s> / login-next <s>   fake status now / what the next register() ends in (off|enabled|requiresApproval|unavailable)
    func startTestHook() {
        guard let dir = testDir else { return }
        Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
            let cmdFile = dir + "/cmd"
            guard let line = try? String(contentsOfFile: cmdFile, encoding: .utf8) else { return }
            try? FileManager.default.removeItem(atPath: cmdFile)
            let l = line.trimmingCharacters(in: .newlines)
            func done(_ s: String) { try? s.write(toFile: dir + "/out", atomically: true, encoding: .utf8) }
            if l.hasPrefix("js ") {
                self.web.callAsyncJavaScript(String(l.dropFirst(3)), arguments: [:], in: nil, in: .page) { r in
                    switch r { case .success(let v): done("\(v)"); case .failure(let e): done("ERR \(e)") }
                }
            } else if l.hasPrefix("snap ") {
                let f = String(l.dropFirst(5))
                self.web.takeSnapshot(with: nil) { img, err in
                    if let img = img, let t = img.tiffRepresentation, let b = NSBitmapImageRep(data: t), let png = b.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: f)); done("ok \(Int(img.size.width))x\(Int(img.size.height))")
                    } else { done("ERR \(String(describing: err))") }
                }
            } else if l.hasPrefix("key ") {
                let k = String(l.dropFirst(4))
                let ev = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: self.window.windowNumber,
                                          context: nil, characters: k, charactersIgnoringModifiers: k, isARepeat: false, keyCode: 0)!
                done("handled=\(NSApp.mainMenu!.performKeyEquivalent(with: ev))")
            } else if l == "reopen" {
                done("handled=\(self.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false))")
            } else if l.hasPrefix("menu ") {
                let t = String(l.dropFirst(5))
                let m = NSApp.mainMenu!.items.last!.submenu!
                if let i = m.items.first(where: { $0.title == t }) { m.performActionForItem(at: m.index(of: i)); done("ok") } else { done("ERR no item") }
            } else if l == "status-menu" {
                self.menuWillOpen(self.statusItem.menu!)   // what opening the menu does
                let items = self.statusItem.menu!.items.filter { !$0.isHidden && !$0.isSeparatorItem }
                let img = self.statusItem.button?.image
                done(items.map { "\($0.title)|\($0.state == .on ? "on" : $0.state == .mixed ? "mixed" : "off")|\($0.isEnabled ? "enabled" : "disabled")" }.joined(separator: "\n")
                     + "\nbutton=\(self.statusItem.button?.title ?? "")|template=\(img?.isTemplate ?? false)|size=\(Int(img?.size.width ?? 0))x\(Int(img?.size.height ?? 0))|dock=\(NSApp.activationPolicy() == .regular)")
            } else if l.hasPrefix("status-click ") {
                let t = String(l.dropFirst(13)); let m = self.statusItem.menu!
                if let i = m.items.first(where: { $0.title == t }) { m.performActionForItem(at: m.index(of: i)); done("ok") } else { done("ERR no item") }
            } else if l.hasPrefix("status-shot ") {
                let f = String(l.dropFirst(12)); let g = menuGlyph(); let s: CGFloat = 8
                let sz = NSSize(width: 20 * s * 2 + 30, height: 18 * s + 20)
                let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(sz.width), pixelsHigh: Int(sz.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
                for (i, dark) in [false, true].enumerated() {
                    let r = NSRect(x: CGFloat(i) * (20 * s + 10) + 10, y: 10, width: 20 * s, height: 18 * s)
                    (dark ? NSColor(white: 0.15, alpha: 1) : NSColor(white: 0.93, alpha: 1)).setFill(); r.fill()
                    let tinted = NSImage(size: g.size, flipped: false) { rr in
                        g.draw(in: rr); (dark ? NSColor.white : NSColor.black).setFill(); rr.fill(using: .sourceIn); return true }
                    tinted.draw(in: r)
                }
                NSGraphicsContext.restoreGraphicsState()
                if let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: f)); done("ok") } else { done("ERR png") }
            } else if l == "poll" {
                self.pollAttention { done("count=\(self.attentionCount) badge=\(NSApp.dockTile.badgeLabel ?? "")") }
            } else if l == "events" {
                done("connected=\(self.stream.connected) running=\(self.stream.running) auth=\(self.testAuth) posted=\(self.testPosted.joined(separator: ";;"))")
            } else if l.hasPrefix("notif-auth ") {
                let v = String(l.dropFirst(11)); self.testAuth = v == "authorized" ? .authorized : v == "denied" ? .denied : .notDetermined
                self.syncSubscription(); done("ok")
            } else if l.hasPrefix("notif-badge ") {
                self.testBadgeOff = l.hasSuffix(" off"); done("ok")
            } else if l == "notif-options" {
                done("options=\(self.testRequestOptions) opened=\(self.testOpened.joined(separator: ","))")
            } else if l == "notif-reset" {
                self.testPosted = []; self.testAuth = .notDetermined; done("ok")
            } else if l.hasPrefix("notif-click ") {
                self.openHash(String(l.dropFirst(12))); done("ok")
            } else if l == "badge" {
                done("badge=\(NSApp.dockTile.badgeLabel ?? "")")
            } else if l == "login" {
                done("status=\(self.testLogin.status.rawValue) calls=\(self.testLogin.calls.joined(separator: ",")) alerts=\(self.testAlerts.joined(separator: ";"))")
            } else if l.hasPrefix("login-set ") {
                self.testLogin.status = LoginStatus(rawValue: String(l.dropFirst(10))) ?? .off; done("ok")
            } else if l.hasPrefix("login-next ") {
                self.testLogin.next = LoginStatus(rawValue: String(l.dropFirst(11))) ?? .enabled; done("ok")
            } else if l == "win" {
                done("\(self.window.frame) visible=\(self.window.isVisible) title=\(self.window.title)")
            } else { done("ERR unknown") }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
