import AppKit
import Combine
import Foundation
import SwiftUI

// MARK: - Models

struct BreakdownItem: Codable, Identifiable, Equatable {
    var id: String { key }
    let key: String
    let label: String
    let tokens: Int
    let color: String
}

struct RecentSession: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let mtime: Double
}

struct ContextSnapshot: Codable, Equatable {
    let found: Bool
    let mode: String?
    let pinnedId: String?
    let conversationId: String?
    let title: String?
    let modelId: String?
    let modelLabel: String?
    let usedTokens: Int?
    let contextLimit: Int?
    let freeSpace: Int?
    let percent: Double?
    let limitSource: String?
    let cacheHitRatio: Double?
    let sessionCacheHitRatio: Double?
    let compactionCount: Int?
    let totalSavedTokens: Int?
    let stepCount: Int?
    let breakdown: [BreakdownItem]?
    let recent: [RecentSession]?
    let error: String?
}

// MARK: - Formatting Helpers

func formatTokens(_ n: Int) -> String {
    if n >= 1_000_000 {
        return String(format: "%.2fM", Double(n) / 1_000_000.0)
    } else if n >= 100_000 {
        return String(format: "%.0fK", Double(n) / 1_000.0)
    } else if n >= 1_000 {
        return String(format: "%.1fK", Double(n) / 1_000.0)
    }
    return "\(n)"
}

func formatCap(_ n: Int) -> String {
    if n >= 1_000_000 {
        let m = Double(n) / 1_000_000.0
        return m == floor(m) ? String(format: "%.0fM", m) : String(format: "%.1fM", m)
    } else if n >= 1_000 {
        return "\(n / 1_000)K"
    }
    return "\(n)"
}

func relativeTime(_ mtimeMs: Double) -> String {
    let diff = max(0, Date().timeIntervalSince1970 - mtimeMs / 1000.0)
    if diff < 60 { return "now" }
    if diff < 3600 { return "\(Int(diff / 60))m" }
    if diff < 86400 { return "\(Int(diff / 3600))h" }
    return "\(Int(diff / 86400))d"
}

extension Color {
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var rgb: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&rgb)
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255.0,
            green: Double((rgb >> 8) & 0xFF) / 255.0,
            blue: Double(rgb & 0xFF) / 255.0
        )
    }
}

func usageColor(for percent: Double) -> Color {
    if percent >= 80 { return Color(hex: "#f87171") } // Coral red
    if percent >= 60 { return Color(hex: "#fbbf24") } // Amber
    return Color(hex: "#34d399") // Emerald
}

// MARK: - Bridge Store

final class BridgeStore: ObservableObject {
    @Published var snapshot: ContextSnapshot?
    @Published var bridgeStatus: String = "Connecting…"
    @Published var onlyWithAntigravity: Bool {
        didSet {
            UserDefaults.standard.set(onlyWithAntigravity, forKey: "onlyWithAntigravity")
            onVisibilityPreferenceChanged?()
        }
    }

    var onVisibilityPreferenceChanged: (() -> Void)?
    var onResetPosition: (() -> Void)?
    var onQuit: (() -> Void)?

    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var buffer = Data()
    private let bridgePath: String
    private let nodePath: String

    init(bridgePath: String, nodePath: String) {
        self.bridgePath = bridgePath
        self.nodePath = nodePath
        if UserDefaults.standard.object(forKey: "onlyWithAntigravity") == nil {
            self.onlyWithAntigravity = true
        } else {
            self.onlyWithAntigravity = UserDefaults.standard.bool(forKey: "onlyWithAntigravity")
        }
    }

    func start() {
        stop()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [bridgePath]
        proc.currentDirectoryURL = URL(fileURLWithPath: bridgePath).deletingLastPathComponent()

        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        self.process = proc
        self.stdinPipe = inPipe
        self.stdoutPipe = outPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            DispatchQueue.main.async {
                self?.handleChunk(chunk)
            }
        }

        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                self?.bridgeStatus = "Bridge exited (\(p.terminationStatus))"
            }
        }

        do {
            try proc.run()
            bridgeStatus = "Running"
        } catch {
            bridgeStatus = "Failed to launch node: \(error.localizedDescription)"
        }
    }

    func stop() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        if let p = process, p.isRunning {
            try? stdinPipe?.fileHandleForWriting.close()
            p.terminate()
        }
        process = nil
        stdinPipe = nil
        stdoutPipe = nil
    }

    func sendCommand(_ payload: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              var line = String(data: data, encoding: .utf8) else { return }
        line.append("\n")
        if let bytes = line.data(using: .utf8) {
            try? stdinPipe?.fileHandleForWriting.write(contentsOf: bytes)
        }
    }

    func selectAuto() {
        sendCommand(["cmd": "auto"])
    }

    func selectSession(_ id: String) {
        sendCommand(["cmd": "select", "id": id])
    }

    private func handleChunk(_ chunk: Data) {
        buffer.append(chunk)
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: 0..<newlineIndex)
            buffer.removeSubrange(0...newlineIndex)
            guard !lineData.isEmpty else { continue }
            if let decoded = try? JSONDecoder().decode(ContextSnapshot.self, from: lineData) {
                self.snapshot = decoded
                self.bridgeStatus = decoded.found ? "Live" : (decoded.error ?? "No active session")
            }
        }
    }
}

// MARK: - SwiftUI Views

struct PillHUDView: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        let snap = store.snapshot
        let used = snap?.usedTokens ?? 0
        let limit = snap?.contextLimit ?? 512_000
        let pct = snap?.percent ?? 0
        let cache = snap?.cacheHitRatio ?? 0
        let isPinned = (snap?.mode == "pinned")
        let accent = usageColor(for: pct)

        HStack(spacing: 8) {
            Circle()
                .fill(snap?.found == true ? accent : Color.gray.opacity(0.6))
                .frame(width: 7, height: 7)
                .shadow(color: accent.opacity(0.6), radius: 3)

            if snap?.found == true {
                Text("\(formatTokens(used)) / \(formatCap(limit))")
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundColor(.white.opacity(0.95))

                Text("\(Int(round(pct)))%")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(accent)

                Rectangle()
                    .fill(Color.white.opacity(0.16))
                    .frame(width: 1, height: 11)

                Text("Cache \(Int(round(cache)))%")
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundColor(.white.opacity(0.72))

                if isPinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9))
                        .foregroundColor(Color(hex: "#38bdf8"))
                }
            } else {
                Text(store.bridgeStatus)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.white.opacity(0.75))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            Capsule()
                .fill(Color.black.opacity(0.72))
                .overlay(
                    Capsule()
                        .strokeBorder(Color.white.opacity(0.16), lineWidth: 0.75)
                )
        )
        .fixedSize()
    }
}

struct DetailPopoverView: View {
    @ObservedObject var store: BridgeStore

    var body: some View {
        let snap = store.snapshot
        let used = snap?.usedTokens ?? 0
        let limit = snap?.contextLimit ?? 512_000
        let free = snap?.freeSpace ?? max(0, limit - used)
        let pct = snap?.percent ?? 0
        let accent = usageColor(for: pct)

        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(snap?.modelLabel ?? "Antigravity Context")
                        .font(.system(size: 13, weight: .semibold))
                    Text("\(formatCap(limit)) compaction cap · \(snap?.mode == "pinned" ? "Pinned" : "Auto latest")")
                        .font(.system(size: 10.5))
                        .foregroundColor(.secondary)
                }
                Spacer()
                Text(String(format: "%.1f%%", pct))
                    .font(.system(size: 16, weight: .bold, design: .monospaced))
                    .foregroundColor(accent)
            }

            // Segmented Bar
            VStack(alignment: .leading, spacing: 5) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.primary.opacity(0.1))
                        HStack(spacing: 1) {
                            ForEach(snap?.breakdown ?? []) { item in
                                let frac = limit > 0 ? CGFloat(item.tokens) / CGFloat(limit) : 0
                                Rectangle()
                                    .fill(Color(hex: item.color))
                                    .frame(width: max(frac > 0 ? 2 : 0, geo.size.width * min(1, frac)))
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }
                .frame(height: 8)

                HStack {
                    Text("\(formatTokens(used)) used")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundColor(.secondary)
                    Spacer()
                    Text("\(formatTokens(free)) free before compaction")
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundColor(accent)
                }
            }

            // Breakdown
            if let items = snap?.breakdown, !items.isEmpty {
                VStack(spacing: 4) {
                    ForEach(items) { item in
                        HStack(spacing: 6) {
                            Circle()
                                .fill(Color(hex: item.color))
                                .frame(width: 6, height: 6)
                            Text(item.label)
                                .font(.system(size: 11))
                                .foregroundColor(.primary.opacity(0.88))
                            Spacer()
                            Text(formatTokens(item.tokens))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
            }

            // Cache & Compaction
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Last Cache")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    Text(String(format: "%.1f%%", snap?.cacheHitRatio ?? 0))
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Session Cache")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    Text(String(format: "%.1f%%", snap?.sessionCacheHitRatio ?? 0))
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Compactions")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    Text("\(snap?.compactionCount ?? 0)")
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                }
            }

            Divider()

            // Session Switcher
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Session")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(.secondary)
                    Spacer()
                    Button(action: { store.selectAuto() }) {
                        HStack(spacing: 3) {
                            if snap?.mode != "pinned" {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 9, weight: .bold))
                            }
                            Text("Auto (Latest)")
                                .font(.system(size: 10.5, weight: .medium))
                        }
                    }
                    .buttonStyle(.borderless)
                    .foregroundColor(snap?.mode != "pinned" ? Color(hex: "#34d399") : .secondary)
                }

                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(snap?.recent ?? []) { item in
                            let selected = (item.id == snap?.conversationId)
                            Button(action: { store.selectSession(item.id) }) {
                                HStack(spacing: 6) {
                                    Circle()
                                        .fill(selected ? Color(hex: "#38bdf8") : Color.clear)
                                        .frame(width: 5, height: 5)
                                    Text(item.title)
                                        .font(.system(size: 11))
                                        .lineLimit(1)
                                        .truncationMode(.tail)
                                        .foregroundColor(selected ? .primary : .secondary)
                                    Spacer()
                                    Text(relativeTime(item.mtime))
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundColor(.secondary.opacity(0.75))
                                }
                                .padding(.horizontal, 6)
                                .padding(.vertical, 4)
                                .background(
                                    RoundedRectangle(cornerRadius: 5)
                                        .fill(selected ? Color.primary.opacity(0.08) : Color.clear)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 130)
            }

            Divider()

            // Footer
            HStack {
                Toggle("Only with Antigravity", isOn: $store.onlyWithAntigravity)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 11))
                Spacer()
                Button("Reset Pos") { store.onResetPosition?() }
                    .buttonStyle(.borderless)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                Button("Quit") { store.onQuit?() }
                    .buttonStyle(.borderless)
                    .font(.system(size: 11))
                    .foregroundColor(Color(hex: "#f87171"))
            }
        }
        .padding(14)
        .frame(width: 310)
    }
}

// MARK: - Draggable & Clickable Non-Activating HUD Panel

final class HUDPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class DragClickContainerView: NSView {
    var onClick: (() -> Void)?
    var onPositionChanged: ((NSPoint) -> Void)?

    private var dragStartScreen: NSPoint = .zero
    private var windowStartOrigin: NSPoint = .zero
    private var didDrag = false

    override func mouseDown(with event: NSEvent) {
        dragStartScreen = NSEvent.mouseLocation
        windowStartOrigin = window?.frame.origin ?? .zero
        didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let win = window else { return }
        let current = NSEvent.mouseLocation
        let dx = current.x - dragStartScreen.x
        let dy = current.y - dragStartScreen.y
        if hypot(dx, dy) > 3 {
            didDrag = true
        }
        if didDrag {
            let newOrigin = NSPoint(x: windowStartOrigin.x + dx, y: windowStartOrigin.y + dy)
            win.setFrameOrigin(newOrigin)
        }
    }

    override func mouseUp(with event: NSEvent) {
        if didDrag {
            if let origin = window?.frame.origin {
                onPositionChanged?(origin)
            }
        } else {
            onClick?()
        }
    }
}

// MARK: - App Delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let antigravityBundleID = "com.google.antigravity"
    private var store: BridgeStore!
    private var panel: HUDPanel!
    private var popover: NSPopover!
    private var statusItem: NSStatusItem!
    private var hostingView: NSHostingView<PillHUDView>!
    private var cancellable: AnyCancellable?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        let bridgePath = env["AGY_HUD_BRIDGE"] ?? resolveDefaultBridgePath()
        let nodePath = env["AGY_HUD_NODE"] ?? resolveNodePath()

        store = BridgeStore(bridgePath: bridgePath, nodePath: nodePath)
        store.onVisibilityPreferenceChanged = { [weak self] in self?.updateHUDVisibility() }
        store.onResetPosition = { [weak self] in self?.resetPanelPosition() }
        store.onQuit = { NSApp.terminate(nil) }

        setupStatusItem()
        setupPanel()
        setupPopover()
        observeActiveApp()

        store.start()
        updateHUDVisibility()
    }

    func applicationWillTerminate(_ notification: Notification) {
        store?.stop()
    }

    private func resolveDefaultBridgePath() -> String {
        if let res = Bundle.main.resourcePath {
            let bundled = (res as NSString).appendingPathComponent("bridge-path.txt")
            if let path = try? String(contentsOfFile: bundled, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
               FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        return FileManager.default.currentDirectoryPath + "/hud/bridge.mjs"
    }

    private func resolveNodePath() -> String {
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return "/usr/bin/env"
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.image = NSImage(systemSymbolName: "gauge.with.dots.needle.33percent", accessibilityDescription: "Antigravity Context HUD")
        }

        let menu = NSMenu()
        menu.addItem(withTitle: "Toggle Details Popover", action: #selector(togglePopoverFromMenu), keyEquivalent: "")
        menu.addItem(withTitle: "Reset HUD Position", action: #selector(resetPanelPosition), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        let onlyItem = NSMenuItem(title: "Only Show with Antigravity", action: #selector(toggleOnlyWithAntigravity(_:)), keyEquivalent: "")
        onlyItem.state = store.onlyWithAntigravity ? .on : .off
        menu.addItem(onlyItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Quit Antigravity Context HUD", action: #selector(quitApp), keyEquivalent: "q")
        statusItem.menu = menu
    }

    private func setupPanel() {
        hostingView = NSHostingView(rootView: PillHUDView(store: store))
        hostingView.translatesAutoresizingMaskIntoConstraints = false

        let container = DragClickContainerView()
        container.addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: container.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        container.onClick = { [weak self] in self?.togglePopover() }
        container.onPositionChanged = { origin in
            UserDefaults.standard.set(Double(origin.x), forKey: "hudOriginX")
            UserDefaults.standard.set(Double(origin.y), forKey: "hudOriginY")
        }

        let initialSize = hostingView.fittingSize
        panel = HUDPanel(
            contentRect: NSRect(origin: .zero, size: initialSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = false
        panel.contentView = container

        restoreOrDefaultPosition()

        cancellable = store.$snapshot.receive(on: DispatchQueue.main).sink { [weak self] _ in
            self?.resizePanelToFit()
        }
    }

    private func resizePanelToFit() {
        guard let panel, let hostingView else { return }
        hostingView.layoutSubtreeIfNeeded()
        let newSize = hostingView.fittingSize
        var frame = panel.frame
        let centerX = frame.midX
        frame.size = newSize
        frame.origin.x = centerX - newSize.width / 2
        panel.setFrame(frame, display: true)
    }

    private func restoreOrDefaultPosition() {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: "hudOriginX") != nil && defaults.object(forKey: "hudOriginY") != nil {
            let x = defaults.double(forKey: "hudOriginX")
            let y = defaults.double(forKey: "hudOriginY")
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        } else {
            resetPanelPosition()
        }
    }

    @objc private func resetPanelPosition() {
        guard let screen = NSScreen.main else { return }
        let vf = screen.visibleFrame
        let size = hostingView.fittingSize
        // Default: centered near bottom (right where Antigravity's composer footer sits)
        let x = vf.midX - size.width / 2
        let y = vf.minY + 18
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        UserDefaults.standard.set(Double(x), forKey: "hudOriginX")
        UserDefaults.standard.set(Double(y), forKey: "hudOriginY")
    }

    private func setupPopover() {
        popover = NSPopover()
        popover.behavior = .transient
        popover.animates = true
        popover.contentViewController = NSHostingController(rootView: DetailPopoverView(store: store))
    }

    private func togglePopover() {
        guard let contentView = panel.contentView else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: contentView.bounds, of: contentView, preferredEdge: .maxY)
        }
    }

    @objc private func togglePopoverFromMenu() {
        panel.orderFrontRegardless()
        togglePopover()
    }

    @objc private func toggleOnlyWithAntigravity(_ sender: NSMenuItem) {
        store.onlyWithAntigravity.toggle()
        sender.state = store.onlyWithAntigravity ? .on : .off
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    private func observeActiveApp() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(activeAppChanged),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
    }

    @objc private func activeAppChanged() {
        updateHUDVisibility()
    }

    private func updateHUDVisibility() {
        if !store.onlyWithAntigravity {
            panel.orderFrontRegardless()
            return
        }
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        let own = Bundle.main.bundleIdentifier ?? ""
        if front == antigravityBundleID || front == own || popover.isShown {
            panel.orderFrontRegardless()
        } else {
            popover.performClose(nil)
            panel.orderOut(nil)
        }
    }
}

// MARK: - Entry Point

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
