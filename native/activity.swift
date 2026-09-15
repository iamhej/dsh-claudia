import Foundation
import AppKit
import CoreGraphics
import IOKit
import Darwin

// --check 在任何 workspace / idle API / 通知初始化之前返回。
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { exit(2) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "--check" {
    emit(["protocol": 1, "source": "local-foreground", "check": true])
    exit(0)
}
guard arguments.count == 4, arguments[1] == "--collect", arguments[2] == "--lock" else { exit(2) }
let lockFD = open(arguments[3], O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, S_IRUSR | S_IWUSR)
var lockStat = stat()
guard lockFD >= 0, fstat(lockFD, &lockStat) == 0,
      (lockStat.st_mode & S_IFMT) == S_IFREG, lockStat.st_nlink == 1,
      lockStat.st_uid == getuid(), flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
    emit(["type": "error", "code": "locked"])
    exit(3)
}

// 只读取 IOHIDSystem 的 idle 秒数，不读取 HID 事件、按键或任何输入内容。
// 属性不可用时停止并提示；没有 RequestAccess / AX / 屏幕录制请求。
func idleSeconds() -> Double? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    guard service != 0 else { return nil }
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber else { return nil }
    let seconds = value.doubleValue / 1_000_000_000
    return seconds.isFinite && seconds >= 0 ? seconds : nil
}
func onConsole() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (session[kCGSessionOnConsoleKey as String] as? Bool == true)
        && (session[kCGSessionLoginDoneKey as String] as? Bool == true)
        && (session["CGSSessionScreenIsLocked"] as? Bool != true)
}
func clean(_ value: String) -> String {
    let forbidden = CharacterSet.controlCharacters.union(.newlines)
    return String(value.unicodeScalars.filter { !forbidden.contains($0) }.map(Character.init).prefix(256))
}
struct AppIdentity: Equatable {
    let name: String
    let bundleId: String
}
func foreground() -> AppIdentity? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let name = clean(app.localizedName ?? "未命名应用")
    return AppIdentity(name: name.isEmpty ? "未命名应用" : name, bundleId: clean(app.bundleIdentifier ?? ""))
}
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
formatter.timeZone = TimeZone(secondsFromGMT: 0)

final class ForegroundClock {
    var sleeping = false
    var sessionActive = onConsole()
    var screenLocked = false
    var lastDate: Date?
    var lastUptime: TimeInterval?
    var lastApp: AppIdentity?
    var wasActive = false
    var tokens: [NSObjectProtocol] = []
    var distributed: [NSObjectProtocol] = []
    var timer: Timer?
    var signals: [DispatchSourceSignal] = []
    var stopping = false

    func reset() {
        lastDate = nil; lastUptime = nil; lastApp = nil; wasActive = false
    }
    func sample(appOverride: AppIdentity? = nil, useOverride: Bool = false) {
        guard !stopping else { return }
        let now = Date(), uptime = ProcessInfo.processInfo.systemUptime
        guard let idle = idleSeconds() else {
            emit(["type": "error", "code": "idle-unavailable"])
            stop(flush: false, code: 4)
            return
        }
        let eligible = !sleeping && sessionActive && !screenLocked && onConsole()
        let app = useOverride ? appOverride : foreground()
        let active = eligible && idle < 60
        if let before = lastDate, let beforeUptime = lastUptime, let previous = lastApp {
            let wall = now.timeIntervalSince(before), monotonic = uptime - beforeUptime
            // heartbeat 超过 10 秒、时钟跳变、睡眠断档一律不补算。
            if wasActive && eligible && wall > 0 && wall <= 10 && monotonic > 0 && abs(wall - monotonic) < 1 {
                // idle 阈值穿越时只记到阈值；重新活跃的第一段保守留空。
                let seconds = max(0, min(wall, wall - max(0, idle - 60)))
                if seconds >= 0.001 {
                    let end = before.addingTimeInterval(seconds)
                    let startISO = formatter.string(from: before), endISO = formatter.string(from: end)
                    if startISO != endISO {
                        emit(["type": "segment", "event": ["name": previous.name, "bundleId": previous.bundleId,
                            "start": startISO, "end": endISO, "seconds": seconds]])
                    }
                }
            }
        }
        lastDate = now; lastUptime = uptime; lastApp = app; wasActive = active && app != nil
        emit(["type": "heartbeat"])
    }
    func start() {
        guard idleSeconds() != nil else {
            emit(["type": "error", "code": "idle-unavailable"]); exit(4)
        }
        let center = NSWorkspace.shared.notificationCenter
        tokens.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let identity = app.map { AppIdentity(name: clean($0.localizedName ?? "未命名应用"), bundleId: clean($0.bundleIdentifier ?? "")) }
            self?.sample(appOverride: identity, useOverride: true)
        })
        tokens.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sample(); self?.sleeping = true; self?.reset()
        })
        tokens.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sleeping = false; self?.sessionActive = onConsole(); self?.reset(); self?.sample()
        })
        tokens.append(center.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sample(); self?.sessionActive = false; self?.reset()
        })
        tokens.append(center.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sessionActive = true; self?.reset(); self?.sample()
        })
        let distributedCenter = DistributedNotificationCenter.default()
        distributed.append(distributedCenter.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            self?.sample(); self?.screenLocked = true; self?.reset()
        })
        distributed.append(distributedCenter.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            self?.screenLocked = false; self?.reset(); self?.sample()
        })
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { DispatchQueue.main.async { self?.stop(flush: false) } }
        }
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.stop(flush: false) }
            source.resume(); signals.append(source)
        }
        emit(["type": "ready", "protocol": 1])
        sample()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.sample() }
    }
    func stop(flush: Bool, code: Int32 = 0) {
        guard !stopping else { return }
        if flush { sample() }
        stopping = true; timer?.invalidate()
        FileHandle.standardInput.readabilityHandler = nil
        for token in tokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }
        for token in distributed { DistributedNotificationCenter.default().removeObserver(token) }
        flock(lockFD, LOCK_UN); close(lockFD)
        exit(code)
    }
}
let clock = ForegroundClock()
clock.start()
RunLoop.main.run()
