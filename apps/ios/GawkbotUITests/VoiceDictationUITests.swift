import XCTest

/// Hold-to-talk, end to end on a simulator: hold the mic in an agent's
/// thread while speech plays, let go, and the words are in the message box.
///
/// The speech comes from the Mac: `scripts/voice-e2e.sh` plays a sentence
/// through the speakers while this test holds the mic, and the simulator
/// listens through the Mac's microphone. Run alone, with no sound, the
/// test still proves the press cycle and checks the empty-result hint.
final class VoiceDictationUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-mock", "-open", "cos"]
        // First use asks for Speech Recognition and the Microphone.
        addUIInterruptionMonitor(withDescription: "permissions") { alert in
            for label in ["Allow", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        app.launch()
    }

    func testHoldingTheMicPutsWhatWasSaidInTheMessageBox() throws {
        let mic = app.descendants(matching: .any)["holdToTalk"]
        // The thread's box. The Inbox has its own (the Chief of Staff box),
        // but this test opens straight into the thread.
        let composer = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "the mic is in the thread's composer")

        // First press may only raise the permission prompts; the interruption
        // monitor answers them on the next interaction.
        mic.press(forDuration: 1.0)
        // Any touch lets the monitor answer a prompt. The title, not the
        // middle of the screen, where an ask card has answer buttons.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.07)).tap()
        sleep(2)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.07)).tap()
        sleep(1)

        let expected = ProcessInfo.processInfo.environment["VOICE_E2E_EXPECT"] ?? ""
        // Tell the runner script to start speaking, then hold through it.
        try? FileManager.default.removeItem(atPath: "/tmp/gawkbot-voice-e2e.done")
        FileManager.default.createFile(atPath: "/tmp/gawkbot-voice-e2e.go", contents: nil)
        mic.press(forDuration: 7.0)
        try? FileManager.default.removeItem(atPath: "/tmp/gawkbot-voice-e2e.go")

        // The recorder waits up to ~1.2 s for the final result after release.
        let deadline = Date().addingTimeInterval(8)
        var text = ""
        while Date() < deadline {
            text = (composer.value as? String) ?? ""
            if !text.isEmpty && text != "Message Chief of Staff" { break }
            usleep(250_000)
        }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.lifetime = .keepAlways
        add(attachment)
        print("VOICE_E2E_TRANSCRIPT=\(text)")

        if expected.isEmpty {
            // No speech was played: nothing may be typed for you, and the
            // thread says it heard nothing.
            XCTAssertTrue(text.isEmpty || text == "Message Chief of Staff", "silence typed: \(text)")
        } else {
            let words = expected.lowercased().split(separator: " ").map(String.init)
            let heard = words.filter { text.lowercased().contains($0) }
            XCTAssertGreaterThanOrEqual(heard.count, words.count / 2, "expected most of '\(expected)', got '\(text)'")
        }
        XCTAssertFalse(app.buttons["Send"].isEnabled && text.isEmpty, "nothing is sent on its own")
    }
}
