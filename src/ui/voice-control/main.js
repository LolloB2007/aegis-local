// Aegis Voice Control - Background Process for macOS
// Integrates with Aegis Local via HTTP API
// Uses Option+Control hotkey for voice capture

import { app, Tray, Menu, globalShortcut, ipcMain, BrowserWindow, screen, shell } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AEGIS_PORT = process.env.AEGIS_PORT || 3210;
const AEGIS_URL = `http://127.0.0.1:${AEGIS_PORT}`;

let isAwake = true;  // Track if the main process is active

class AegisVoiceControl {
  constructor() {
    this.tray = null;
    this.audioProcess = null;
    this.recording = false;
    this.tempDir = os.tmpdir();
    this.audioFile = null;
    this.overlayWindow = null;
    this.hotkeyRegistered = false;
    this.hotkeyFormat = 'Opt+Ctrl';
  }

  createOverlayWindow() {
    if (this.overlayWindow) return;
    
    this.overlayWindow = new BrowserWindow({
      width: 80,
      height: 50,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    
    const overlayPath = path.join(__dirname, 'overlay.html');
    this.overlayWindow.loadFile(overlayPath);
  }

  showOverlay() {
    if (!this.overlayWindow) {
      this.createOverlayWindow();
    }
    // Position at top-right of primary display
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    // 10px margin from top and right
    this.overlayWindow.setPosition(width - 80 - 10, 10);
    this.overlayWindow.show();
  }

  hideOverlay() {
    if (this.overlayWindow) {
      this.overlayWindow.hide();
    }
  }

  goAwake() {
    if (isAwake) return;
    console.log('Waking up - re-enabling shortcuts');
    isAwake = true;
    this.registerHotkeys();
  }

  goSleep() {
    if (!isAwake) return;
    console.log('Going to sleep - freeing RAM');
    isAwake = false;
    
    // Kill audio process if recording
    if (this.audioProcess) {
      this.audioProcess.kill();
      this.audioProcess = null;
    }
    
    // Hide overlay
    this.hideOverlay();
    
    // Unregister shortcuts
    globalShortcut.unregisterAll();
    
    // Update tray menu
    this.updateTrayMenu('sleep');
  }

  setupSleepMode() {
    // Right-click menu: sleep to free RAM, tray stays visible
    this.tray.on('right-click', () => {
      const sleepMenu = Menu.buildFromTemplate([
        {
          label: isAwake ? 'Sleep (Free RAM)' : 'Wake Up',
          type: 'normal',
          click: () => {
            if (isAwake) {
              // Free RAM but keep tray
              this.goSleep();
            } else {
              // Wake up and re-enable
              this.goAwake();
            }
          }
        },
        {
          label: 'Quit (Close App)',
          type: 'normal',
          click: () => {
            globalShortcut.unregisterAll();
            app.quit();
          }
        }
      ]);
      this.tray.popUpContextMenu(sleepMenu);
    });
  }

  registerHotkeys() {
    console.log('Registering global hotkey: Option+Control');
    
    // Electron 44.x accelerator format on macOS
    // The accelerator parser expects specific formats
    // Try Option+Control first (user's preference), then fallbacks
    const formats = [
      'Option+Control',   // User's requested format (may fail in Electron 44.x)
      'Option+Space',     // Functional alternative
      'Command+Option',   // Another variation
      'Control+Option'    // Reversed order
    ];
    
    let registered = false;
    for (const format of formats) {
      try {
        const result = globalShortcut.register(format, () => {
          this.startRecording();
        });
        if (result) {
          console.log(`Hotkey registered successfully with format: ${format}`);
          registered = true;
          this.hotkeyFormat = format;
          break;
        }
      } catch (err) {
        console.error(`Format ${format} failed:`, err.message);
      }
    }
    
    if (!registered) {
      console.error('Failed to register global hotkey with all formats');
      this.hotkeyRegistered = false;
      this.hotkeyFormat = 'Opt+Ctrl (tray menu only)';
    } else {
      this.hotkeyRegistered = true;
    }
  }

  async initialize() {
    // Register IPC handlers
    ipcMain.on('stop-recording', () => this.stopRecording());
    
    // Hide app from Dock
    app.dock.hide();
    
    // Create tray icon
    const iconPath = path.join(__dirname, 'resources', 'aegis-icon.png');
    
    this.tray = new Tray(iconPath);
    this.tray.setToolTip('Aegis Voice Control');
    
    const contextMenu = Menu.buildFromTemplate([
      { 
        label: isAwake ? 'Aegis Voice Control' : 'Awake - Click to Enable', 
        enabled: false 
      },
      { type: 'separator' },
      {
        label: `🔊 Speak to Aegis (${this.hotkeyFormat || 'Opt+Ctrl'})`,
        enabled: isAwake, // Enabled when awake, disabled when sleeping
        click: () => this.startRecording()
      },
      {
        label: isAwake ? '💤 Sleep (Free RAM)' : '🔆 Wake Up',
        click: () => isAwake ? this.goSleep() : this.goAwake()
      },
      {
        label: '⚙️ Configuration',
        click: () => this.openConfig()
      },
      { type: 'separator' },
      { 
        label: '🔻 Quit', 
        click: () => {
          globalShortcut.unregisterAll();
          app.quit(); 
        }
      }
    ]);
    
    this.tray.setContextMenu(contextMenu);
    
    // Setup sleep mode right-click
    this.setupSleepMode();
    
    // Register hotkeys
    this.registerHotkeys();
  }

  async startRecording() {
    if (!isAwake) return;
    if (this.recording) return;
    
    console.log('Recording started...');
    this.recording = true;
    
    // Update tray menu
    this.updateTrayMenu(true);
    
    // Generate unique audio file path
    const timestamp = Date.now();
    this.audioFile = path.join(this.tempDir, `aegis_${timestamp}.wav`);
    
    // Use ffmpeg to record audio (avfoundation on macOS)
    this.audioProcess = spawn('ffmpeg', [
      '-f', 'avfoundation', // macOS audio device format
      '-i', ':2',          // MacBook Air Microphone (default input)
      '-t', '60',          // Max 60 seconds
      '-y',                // Overwrite
      '-ar', '16000',      // Sample rate for parakeet
      '-ac', '1',          // Mono
      this.audioFile
    ], {
      cwd: __dirname
    });
    
    this.audioProcess.on('close', async (code) => {
      if (code === 0 && this.audioFile) {
        console.log('Recording finished, processing...');
        await this.processAudio();
      }
      this.recording = false;
      this.updateTrayMenu(false);
      this.hideOverlay();
    });
    
    this.audioProcess.on('error', (err) => {
      console.error('Recording error:', err);
      this.recording = false;
      this.updateTrayMenu(false);
      this.hideOverlay();
    });
    
    // Show visual overlay when recording starts
    this.showOverlay();
  }

  async stopRecording() {
    if (this.audioProcess) {
      this.audioProcess.kill();
    }
    this.recording = false;
    this.updateTrayMenu(false);
    this.hideOverlay();
  }

  updateTrayMenu(state) {
    const hotkeyLabel = this.hotkeyFormat || 'Opt+Ctrl';
    let label, enabled;
    
    if (state === 'sleep') {
      label = '💤 Slept';
      enabled = false;
    } else if (state === true) {
      label = '🎙️ Recording...';
      enabled = false;
    } else {
      label = isAwake ? `🔊 Speak to Aegis (${hotkeyLabel})` : '💤 Click to Wake Up';
      enabled = isAwake;
    }
    
    const contextMenu = Menu.buildFromTemplate([
      { 
        label, 
        enabled: false 
      },
      { type: 'separator' },
      {
        label: state === true ? '⏹️ Stop Recording' : (isAwake ? `🔊 Speak to Aegis (${hotkeyLabel})` : '💤 Click to Wake Up'),
        click: () => state ? this.stopRecording() : this.goAwake()
      },
      {
        label: isAwake ? '💤 Sleep (Free RAM)' : '🔆 Wake Up',
        click: () => isAwake ? this.goSleep() : this.goAwake()
      },
      {
        label: '⚙️ Configuration',
        click: () => this.openConfig()
      },
      { type: 'separator' },
      { 
        label: '🔻 Quit', 
        click: () => {
          globalShortcut.unregisterAll();
          app.quit(); 
        }
      }
    ]);
    
    this.tray.setContextMenu(contextMenu);
  }

  async processAudio() {
    if (!this.audioFile || !fs.existsSync(this.audioFile)) return;
    
    try {
      // Transcribe using parakeet-transcribe
      const transcript = await this.transcribeAudio(this.audioFile);
      
      if (transcript.success && transcript.text.trim()) {
        console.log('Transcription:', transcript.text);
        
        // Send to Aegis Local
        await this.sendToAegis(transcript.text);
        
        // Clean up audio file
        fs.unlinkSync(this.audioFile);
      }
    } catch (err) {
      console.error('Processing error:', err);
    } finally {
      this.audioFile = null;
    }
  }

  async transcribeAudio(filePath) {
    return new Promise((resolve) => {
      // Use parakeet-transcribe (from Hermes setup)
      const parakeetPath = '/Users/lorenzobarbagelata/.local/bin/parakeet-transcribe';
      
      if (fs.existsSync(parakeetPath)) {
        const outputPath = path.join(this.tempDir, 'aegis_transcript.txt');
        
        const proc = spawn(parakeetPath, [
          '--format', 'text',
          '--output', outputPath,
          filePath
        ]);
        
        let stderr = '';
        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            const text = fs.readFileSync(outputPath, 'utf-8').trim();
            fs.unlinkSync(outputPath);
            resolve({ success: code === 0, text });
          } else {
            // Parakeet may return empty output for silence or errors
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
            resolve({ success: true, text: '' });
          }
        });
        
        return;
      }
      
      // Fallback: return empty transcript
      resolve({ success: true, text: '' });
    });
  }

  async sendToAegis(text) {
    if (!text.trim()) return;
    
    const payload = JSON.stringify({ message: text });
    
    const options = {
      hostname: '127.0.0.1',
      port: AEGIS_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Aegis-Local': '1'
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✓ Command executed:', text);
        } else {
          console.error('✗ Aegis API error:', res.statusCode);
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('Failed to connect to Aegis:', err.message);
    });
    
    req.write(payload);
    req.end();
  }

  openConfig() {
    shell.openExternal(`${AEGIS_URL}/configuration`);
  }

  cleanup() {
    if (this.audioProcess) {
      this.audioProcess.kill();
    }
    if (this.overlayWindow) {
      this.overlayWindow.destroy();
    }
    globalShortcut.unregisterAll();
  }
}

// Main app setup
const voiceControl = new AegisVoiceControl();

app.whenReady().then(() => {
  // Hide from dock early
  app.dock.hide();
  
  voiceControl.initialize();
});

app.on('before-quit', () => {
  voiceControl.cleanup();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    voiceControl.initialize();
  }
});