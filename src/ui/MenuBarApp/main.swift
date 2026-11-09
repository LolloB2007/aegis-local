// Aegis Local Menu Bar App
// A background process with voice control via Option+Control hotkey

import Cocoa
import AVFoundation

@main
struct AegisMenuBar {
    static let shared = AegisMenuBar()
    
    // Configuration
    private let aegisPort = 3210
    private let aegisUrl = "http://127.0.0.1:3210"
    
    // UI Components
    private var statusItem: NSStatusItem!
    private var menu: NSMenu!
    
    // Audio recording
    private let audioEngine = AVAudioEngine()
    private var recordingSession: AVAudioSession?
    private var currentAudioFile: URL?
    private var recordingStartTime: CFTimeInterval = 0
    
    // Hotkey monitoring
    private var hotkeyMonitor: NSHotKey?
    private var eventMonitor: Any?
    
    // Transcription
    private var transcriptionTask: Task<Void, Never>?
    
    init() {
        setupMenuBar()
        setupHotkey()
        setupPermissions()
    }
    
    private func setupMenuBar() {
        // Create status bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        
        // Create menu
        menu = NSMenu()
        
        // Add menu items
        let titleLabel = NSAttributedLabel()
        titleLabel.stringValue = "Aegis"
        titleLabel.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        menu.addItem(withTitle: NSMenuItem(title: "", action: #selector(doNothing), keyEquivalent: ""))
        menu.items[0].view = titleLabel
        menu.items[0].isEnabled = false
        
        menu.addItem(separator: true)
        
        menu.addItem(NSMenuItem(title: "Speak to Aegis (Opt+Ctrl)", action: #selector(showListeningStatus), keyEquivalent: ""))
        menu.items.last?.isEnabled = false  // Disabled - hotkey triggers it
        
        menu.addItem(NSMenuItem(title: "Restart Aegis Server", action: #selector(restartServer), keyEquivalent: ""))
        
        menu.addItem(separator: true)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"))
        
        statusItem.menu = menu
        
        // Set initial icon
        updateMenuIcon(isListening: false)
    }
    
    private func setupHotkey() {
        // Option+Control hotkey
        let keyCode: UInt = 54  // Option key
        let modifiers: NSEvent.ModifierFlags = [.option, .control]
        
        do {
            try NSApp.setActivationPolicy(.regular)  // Ensure app can receive events
            hotkeyMonitor = NSHotKey.register(
                with: NSApp.mainMenu?.window?.firstResponder ?? NSApp,
                key: keyCode,
                modifiers: modifiers
            ) { [weak self] in
                self?.startVoiceCapture()
            }
        } catch {
            print("Failed to register hotkey: \(error)")
        }
    }
    
    private func setupPermissions() {
        // Request microphone permission
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            if !granted {
                print("Microphone access denied")
            }
        }
    }
    
    @objc private func doNothing() {}
    
    private func updateMenuIcon(isListening: Bool) {
        let imageName = isListening ? "mic.fill" : "waveform"
        guard let image = NSImage(systemSymbolName: imageName, accessibilityDescription: nil) else {
            return
        }
        image.templateRenderingMode = .alwaysTemplate
        statusItem.button?.image = image
        statusItem.button?.contentVMargin = 2
    }
    
    @objc private func showListeningStatus() {
        // Update menu to show listening state
        menu.removeItem(withTag: 999)  // Remove old listening item if exists
        
        let listeningLabel = NSMenuItem(title: "Listening...", action: #selector(stopVoiceCapture), keyEquivalent: "")
        listeningLabel.isEnabled = false
        listeningLabel.tag = 999
        menu.insertItem(listeningLabel, at: 3)
        
        statusItem.button?.image = NSImage(systemSymbolName: "microphone.fill", accessibilityDescription: "Listening")
    }
    
    private func startVoiceCapture() {
        stopTranscription()
        
        let now = CACurrentMediaTime()
        recordingStartTime = now
        
        // Create temp audio file
        let tempDir = FileManager.default.temporaryDirectory
        let audioFileName = "aegis_\(Int(now)).wav"
        currentAudioFile = tempDir.appendingPathComponent(audioFileName)
        
        // Configure audio session
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: [.notifyOthersOnDeactivation])
            
            // Install tap on audio engine
            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            
            // Create WAV file header
            createEmptyWAVFile(url: currentAudioFile!, sampleRate: format.sampleRate)
            
            // Open file for writing
            let file = try AVAudioFile(forWriting: currentAudioFile!)
            
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                // This is a placeholder - actual recording handled by shell command
            }
            
            try audioEngine.start()
            
            updateMenuIcon(isListening: true)
            
            // Show listening status in menu
            showListeningStatus()
            
        } catch {
            print("Audio setup failed: \(error)")
        }
    }
    
    private func stopVoiceCapture() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        
        AVAudioSession.sharedInstance().setActive(false, options: [])
        
        updateMenuIcon(isListening: false)
        
        // Re-check menu items for recording session
        if let fileURL = currentAudioFile, FileManager.default.fileExists(atPath: fileURL.path) {
            // Process the recording
            transcribeAndSend(audioFile: fileURL)
        }
    }
    
    @objc private func stopVoiceCapture() {
        stopVoiceCapture()
        
        // Update menu back to normal
        menu.removeItem(withTag: 999)
        menu.removeItem(at: 3)  // Remove the listening item we added
        
        menu.insertItem(NSMenuItem(title: "Speak to Aegis (Opt+Ctrl)", action: #selector(showListeningStatus), keyEquivalent: ""), at: 3)
    }
    
    private func createEmptyWAVFile(url: URL, sampleRate: Float) {
        // Create a minimal WAV file structure
        // This is a simplified version - proper implementation would write actual audio data
        let header = Data([
            0x52, 0x49, 0x46, 0x46,  // "RIFF"
            0x00, 0x00, 0x00, 0x00,  // File size (placeholder)
            0x57, 0x41, 0x56, 0x45,  // "WAVE"
            0x66, 0x6D, 0x74, 0x20,  // "fmt "
            0x10, 0x00, 0x00, 0x00,  // Chunk size (16 for PCM)
            0x01, 0x00,              // Audio format (1 = PCM)
            0x01, 0x00,              // Num channels (1 = mono)
            UInt32(sampleRate).littleEndian,  // Sample rate
            UInt32(sampleRate).littleEndian,  // Byte rate
            0x01, 0x00,              // Block align
            0x10, 0x00,              // Bits per sample
            0x64, 0x61, 0x74, 0x61,  // "data"
            0x00, 0x00, 0x00, 0x00   // Data size (placeholder)
        ])
        
        try? header.write(to: url)
    }
    
    private func transcribeAndSend(audioFile: URL) {
        Task { [weak self] in
            guard let self = self else { return }
            
            // Method 1: Use whisper.cpp via shell
            let whisperPath = "/usr/local/bin/whisper.cpp"
            
            // Method 2: Use Python whisper via subprocess
            let pythonScript = """
            import sys
            import json
            try:
                import whisper
                model = whisper.load_model("base")
                result = model.transcribe("\(audioFile.path)")
                print(json.dumps({"text": result["text"], "success": True}))
            except ImportError:
                print(json.dumps({"error": "whisper not installed", "success": False}))
            """
            
            // Try Python whisper first, fallback to shell command
            let transcript = await self.getTranscript(audioFile: audioFile)
            
            if transcript.success {
                // Send to Aegis Local API
                await self.sendToAegis(text: transcript.text)
            }
        }
    }
    
    private func getTranscript(audioFile: URL) async -> (text: String, success: Bool) {
        // Check for whisper binary
        let whisperCppPath = "/opt/homebrew/bin/whisper"
        let whisperModelPath = "/Users/lorenzobarbagelata/.cache/whisper/ggml-base.bin"
        
        if FileManager.default.fileExists(atPath: whisperCppPath) {
            // Use whisper.cpp
            let task = Process()
            task.executableURL = URL(fileURLWithPath: whisperCppPath)
            task.arguments = [
                "-m", whisperModelPath,
                "-f", audioFile.path,
                "-otxt",
                "-ot"
            ]
            
            let pipe = Pipe()
            task.standardOutput = pipe
            
            do {
                try task.run()
                task.waitUntilExit()
                
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""
                
                return (text: output.trimmingCharacters(in: .whitespacesAndNewlines), success: true)
            } catch {
                print("whisper.cpp failed: \(error)")
            }
        }
        
        // Fallback: Use Python whisper
        let pythonPath = "/opt/homebrew/bin/python3"
        let script = """
import whisper
import json
import sys

model = whisper.load_model("base")
result = model.transcribe("\(audioFile.path)")
print(json.dumps({"text": result["text"].strip()}))
"""
        
        let task = Process()
        task.executableURL = URL(fileURLWithPath: pythonPath)
        task.arguments = ["-c", script]
        
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        
        do {
            try task.run()
            task.waitUntilExit()
            
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            
            if let json = output.data(using: .utf8),
               let dict = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
               let text = dict["text"] as? String {
                return (text: text, success: true)
            }
        } catch {
            print("Python whisper failed: \(error)")
        }
        
        return (text: "", success: false)
    }
    
    private func sendToAegis(text: String) async {
        guard !text.isEmpty else { return }
        
        let url = URL(string: "\(aegisUrl)/api/chat")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("1", forHTTPHeaderField: "X-Aegis-Local")
        
        let body = ["message": text]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [])
        
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            
            if let httpResponse = response as? HTTPURLResponse {
                if httpResponse.statusCode == 200 {
                    print("Sent to Aegis: \(text)")
                }
            }
        } catch {
            print("Failed to send to Aegis: \(error)")
        }
    }
    
    private func stopTranscription() {
        transcriptionTask?.cancel()
    }
    
    @objc private func restartServer() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        task.arguments = ["-f", "node.*server.mjs"]
        
        do {
            try task.run()
            print("Killed existing server")
        } catch {
            print("No server to kill: \(error)")
        }
        
        // Optionally restart server
    }
    
    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}