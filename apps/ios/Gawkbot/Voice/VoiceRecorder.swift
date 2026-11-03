import AVFoundation
import Combine
import os
import Speech
import GawkbotKit

/// Hold-to-talk dictation. Listens only between `start()` and `stop()`,
/// shows the transcript live, and on release waits briefly for the final
/// result, then hands the transcript to its owner (`.confirming`; the
/// thread puts it in the message box). It never sends anything itself.
///
/// Recognition runs on the phone when `supportsOnDeviceRecognition` is true;
/// otherwise Speech uses Apple's service (the Info.plist string says so).
@MainActor
final class VoiceRecorder: ObservableObject {
    enum Phase: Equatable {
        case idle
        /// Asking for permission / bringing the mic up.
        case starting
        case listening
        /// Released; waiting a moment for the final transcript.
        case finishing
        /// The transcript is ready for the owner to take, then `reset()`.
        case confirming
    }

    struct Problem: Identifiable, Equatable {
        let message: String
        /// Offer a jump to Settings (permission was refused).
        let offerSettings: Bool
        var id: String { message }
    }

    @Published private(set) var phase: Phase = .idle {
        didSet { if phase != oldValue { VoiceRecorder.log.debug("phase \(String(describing: oldValue)) -> \(String(describing: self.phase))") } }
    }
    /// `log stream --predicate 'subsystem == "bot.gawk.ios" && category == "voice"' --level debug`
    static let log = Logger(subsystem: "bot.gawk.ios", category: "voice")
    /// Live while listening; final (trimmed) once confirming.
    @Published var transcript = ""
    @Published var problem: Problem? = nil
    /// Mic level for the pulsing ring, kept on its own object so a 40 Hz
    /// meter does not re-render the whole thread.
    let meter: VoiceMeter
    /// Start/stop blips; set by the owner.
    var onCue: (@MainActor (SoundCue) -> Void)?

    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finishTimeout: Task<Void, Never>?
    /// Bumped by every start, so a start still awaiting permission can tell
    /// it was released and superseded by a newer press.
    private var attempt = 0
    /// Only touch the input node's tap after we installed one.
    private var tapInstalled = false
    /// The recognizer this recording uses, kept for the fallback below.
    private var recognizer: SFSpeechRecognizer?
    /// This recording asked for on-device recognition.
    private var onDevice = false
    /// On-device recognition failed to start on this phone (its model is
    /// not downloaded, or the simulator has none). Apple's speech service
    /// is used from then on, as the permission prompt says it may be.
    private var onDeviceUnavailable = false
    /// Bumped per recognition task, so a cancelled task's late callback
    /// cannot end the recording that replaced it.
    private var taskGeneration = 0

    init() {
        meter = VoiceMeter()
    }

    var isActive: Bool { phase == .starting || phase == .listening || phase == .finishing }

    // MARK: - Control

    /// VoiceOver path: activate once to start, again to stop.
    func toggle() async {
        switch phase {
        case .idle: await start()
        case .starting, .listening: stop()
        case .finishing, .confirming: break
        }
    }

    func start() async {
        guard phase == .idle else { return }
        attempt += 1
        let mine = attempt
        phase = .starting
        transcript = ""
        guard await ensurePermissions() else {
            if attempt == mine { phase = .idle }
            return
        }
        guard attempt == mine, phase == .starting else { return }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(), recognizer.isAvailable else {
            problem = Problem(message: "Speech recognition isn't available right now. Check your connection, or try again in a moment.", offerSettings: false)
            phase = .idle
            return
        }
        // The start blip plays on the ambient session; give it a beat before
        // the recording session takes over.
        onCue?(.voiceStart)
        try? await Task.sleep(for: .milliseconds(90))
        // Released (or cancelled) while permission or the blip was pending.
        guard attempt == mine, phase == .starting else { return }
        do {
            try begin(with: recognizer)
            phase = .listening
        } catch {
            VoiceRecorder.log.error("mic start failed: \(error.localizedDescription, privacy: .public)")
            stopAudio()
            restoreSession()
            problem = Problem(message: "Couldn't start the microphone: \(error.localizedDescription)", offerSettings: false)
            phase = .idle
        }
    }

    /// The finger lifted.
    func stop() {
        switch phase {
        case .starting:
            phase = .idle
        case .listening:
            stopAudio()
            request?.endAudio()
            phase = .finishing
            finishTimeout?.cancel()
            finishTimeout = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(1200))
                self?.finish()
            }
        case .idle, .finishing, .confirming:
            break
        }
    }

    /// Leaving the thread mid-recording. Nothing is kept.
    func cancel() {
        let wasRecording = phase == .listening || phase == .finishing
        finishTimeout?.cancel()
        finishTimeout = nil
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        restoreSession()
        transcript = ""
        phase = .idle
        if wasRecording { onCue?(.voiceStop) }
    }

    /// The owner took the transcript; back to the resting state.
    func reset() {
        transcript = ""
        phase = .idle
    }

    // MARK: - Recognition

    private func begin(with recognizer: SFSpeechRecognizer) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        self.recognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // `supportsOnDeviceRecognition` can be true while the model is not
        // there; then the task fails at once and `handle` falls back.
        onDevice = recognizer.supportsOnDeviceRecognition && !onDeviceUnavailable
        request.requiresOnDeviceRecognition = onDevice

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceError.noMicrophone }
        if tapInstalled { input.removeTap(onBus: 0) }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: VoiceRecorder.makeTap(request: request, meter: meter))
        tapInstalled = true
        audioEngine.prepare()
        try audioEngine.start()

        self.request = request
        taskGeneration += 1
        let generation = taskGeneration
        task = recognizer.recognitionTask(with: request, resultHandler: VoiceRecorder.makeResultHandler { [weak self] text, isFinal, failed in
            guard let self, generation == self.taskGeneration else { return }
            self.handle(text: text, isFinal: isFinal, failed: failed)
        })
    }

    private func handle(text: String?, isFinal: Bool, failed: Bool) {
        // On-device recognition could not start: restart this same
        // recording on Apple's service rather than end it with nothing.
        if failed, onDevice, phase == .listening, transcript.isEmpty, let recognizer {
            VoiceRecorder.log.error("on-device recognition failed to start; using the speech service")
            onDeviceUnavailable = true
            task?.cancel()
            task = nil
            request = nil
            stopAudio()
            do {
                try begin(with: recognizer)
            } catch {
                VoiceRecorder.log.error("mic restart failed: \(error.localizedDescription, privacy: .public)")
                restoreSession()
                problem = Problem(message: "Couldn't start the microphone: \(error.localizedDescription)", offerSettings: false)
                phase = .idle
            }
            return
        }
        VoiceRecorder.log.debug("result chars=\(text?.count ?? -1) final=\(isFinal) failed=\(failed)")
        if let text, phase == .listening || phase == .finishing {
            transcript = text
        }
        switch phase {
        case .finishing where isFinal || failed:
            finish()
        case .listening where failed || isFinal:
            // Recognition ended on its own (time limit, lost model): keep
            // what was heard and hand it over.
            stopAudio()
            phase = .finishing
            finish()
        default:
            break
        }
    }

    private func finish() {
        guard phase == .finishing else { return }
        finishTimeout?.cancel()
        finishTimeout = nil
        task?.cancel()
        task = nil
        request = nil
        restoreSession()
        onCue?(.voiceStop)
        transcript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        phase = .confirming
    }

    private func stopAudio() {
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        meter.level = 0
    }

    /// Hand the session back so music resumes and the cue sounds (ambient) play.
    private func restoreSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(.ambient, mode: .default, options: [])
    }

    // MARK: - Permissions

    private func ensurePermissions() async -> Bool {
        var speech = SFSpeechRecognizer.authorizationStatus()
        if speech == .notDetermined {
            speech = await VoiceRecorder.requestSpeechAuthorization()
        }
        guard speech == .authorized else {
            problem = Problem(
                message: speech == .restricted
                    ? "Speech recognition is restricted on this iPhone."
                    : "To talk to your agents, allow Speech Recognition for gawkbot in Settings. You can still type.",
                offerSettings: speech == .denied
            )
            return false
        }
        var mic = AVAudioApplication.shared.recordPermission
        if mic == .undetermined {
            mic = await VoiceRecorder.requestMicrophone() ? .granted : .denied
        }
        guard mic == .granted else {
            problem = Problem(message: "To talk to your agents, allow the Microphone for gawkbot in Settings. You can still type.", offerSettings: true)
            return false
        }
        return true
    }

    // The callbacks below are built in nonisolated contexts on purpose: the
    // audio tap and Speech's handlers run on background threads, and a
    // closure formed inside this @MainActor class would be main-actor
    // isolated.

    private nonisolated static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in continuation.resume(returning: status) }
        }
    }

    private nonisolated static func requestMicrophone() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in continuation.resume(returning: granted) }
        }
    }

    private nonisolated static func makeTap(request: SFSpeechAudioBufferRecognitionRequest, meter: VoiceMeter) -> AVAudioNodeTapBlock {
        { buffer, _ in
            request.append(buffer)
            let level = VoiceRecorder.rms(buffer)
            Task { @MainActor in meter.level = level }
        }
    }

    private nonisolated static func makeResultHandler(_ deliver: @escaping @MainActor @Sendable (String?, Bool, Bool) -> Void) -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
        { result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            if let error { VoiceRecorder.log.error("recognition error: \(error.localizedDescription, privacy: .public)") }
            Task { @MainActor in deliver(text, isFinal, failed) }
        }
    }

    private nonisolated static func rms(_ buffer: AVAudioPCMBuffer) -> Double {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n {
            let s = data[0][i]
            sum += s * s
        }
        return Double(min(1, (sum / Float(n)).squareRoot() * 8))
    }
}

enum VoiceError: LocalizedError {
    case noMicrophone
    var errorDescription: String? { "No microphone is available." }
}

/// The live mic level, 0…1, for the listening ring only.
@MainActor
final class VoiceMeter: ObservableObject {
    @Published var level: Double = 0
}
