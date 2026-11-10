// Aegis Voice Control: microphone input only; commands execute through the guarded Node API.

import { app, Tray, Menu, globalShortcut, ipcMain, BrowserWindow, screen, shell } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import http from 'http';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AEGIS_PORT = process.env.AEGIS_PORT || 3210;
const AEGIS_URL = `http://127.0.0.1:${AEGIS_PORT}`;

let isAwake = true;
let recording = false;
let audioProcess = null;
let audioFile = null;
let overlayWindow = null;
let trayInstance = null;
let hotkeyFormat = 'Option+Space';

// --- Overlay Window ---

function createOverlayWindow() {
  if (overlayWindow) return;
  
  overlayWindow = new BrowserWindow({
    width: 340,
    height: 220,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  
  const overlayPath = path.join(__dirname, 'overlay.html');
  overlayWindow.loadFile(overlayPath);
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function sendOverlayEvent(channel, value) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const target = overlayWindow;
  const send = () => { if (!target.isDestroyed()) target.webContents.send(channel, value); };
  if (target.webContents.isLoadingMainFrame()) target.webContents.once('did-finish-load', send);
  else send();
}

function showOverlay() {
  if (!overlayWindow) createOverlayWindow();
  const area = screen.getPrimaryDisplay().workArea;
  overlayWindow.setPosition(area.x + area.width - 350, area.y + 10);
  overlayWindow.show();
  sendOverlayEvent('recording-started');
}

function hideOverlay() {
  if (overlayWindow) overlayWindow.hide();
}

function showOverlayWithText(text) {
  if (!overlayWindow) createOverlayWindow();
  const area = screen.getPrimaryDisplay().workArea;
  overlayWindow.setPosition(area.x + area.width - 350, area.y + 10);
  overlayWindow.show();
  sendOverlayEvent('transcription-ready', text || '');
}

// --- Recording ---

async function startRecording() {
  if (!isAwake) return;
  if (recording) {
    stopRecording();
    return;
  }
  
  console.log('Recording started...');
  recording = true;
  
  audioFile = path.join(os.tmpdir(), `aegis_${process.pid}_${randomUUID()}.wav`);
  
  audioProcess = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-i', process.env.AEGIS_AUDIO_DEVICE || ':0',
    '-t', '60',
    '-y',
    '-ar', '16000',
    '-ac', '1',
    audioFile
  ], { cwd: __dirname, stdio: ['ignore', 'ignore', 'pipe'] });

  audioProcess.stderr.on('data', data => { if (process.env.AEGIS_VOICE_DEBUG === '1') console.error(String(data).slice(0, 500)); });
  audioProcess.on('error', error => { console.error('ffmpeg failed:', error.message); recording = false; audioProcess = null; showOverlayWithText(`Microphone error: ${error.message}`); });
  
  audioProcess.on('close', async () => {
    audioProcess = null;
    if (audioFile && fs.existsSync(audioFile) && fs.statSync(audioFile).size > 44) {
      console.log('Recording finished, processing...');
      await processAudio();
    }
    recording = false;
  });
  
  showOverlay();
}

async function stopRecording() {
  if (audioProcess) {
    sendOverlayEvent('recording-stopped');
    audioProcess.kill('SIGTERM');
  }
}

// --- Audio Processing ---

async function processAudio() {
  if (!audioFile || !fs.existsSync(audioFile)) return;
  
  try {
    const transcript = await transcribeAudio(audioFile);
    
    if (transcript.success && transcript.text.trim()) {
      console.log('Transcription:', transcript.text);
      showOverlayWithText(transcript.text);
      await sendToAegis(transcript.text);
    } else {
      showOverlayWithText('');
    }
  } catch (err) {
    console.error('Processing error:', err);
  } finally {
    if (audioFile && fs.existsSync(audioFile)) { try { fs.unlinkSync(audioFile); } catch (e) { console.error('Audio cleanup:', e.message); } }
    audioFile = null;
  }
}

async function transcribeAudio(filePath) {
  return new Promise((resolve) => {
    const parakeetPath = process.env.PARAKEET_TRANSCRIBE || path.join(os.homedir(), '.local/bin/parakeet-transcribe');
    
    if (fs.existsSync(parakeetPath)) {
      const outputPath = path.join(os.tmpdir(), `aegis_transcript_${process.pid}_${randomUUID()}.txt`);
      const proc = spawn(parakeetPath, ['--format', 'text', '--output', outputPath, filePath]);
      
      proc.stderr.on('data', () => {});
      proc.on('error', error => {
        console.error('Parakeet startup error:', error.message);
        resolve({ success: false, text: '' });
      });
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          const text = fs.readFileSync(outputPath, 'utf-8').trim();
          fs.unlinkSync(outputPath);
          resolve({ success: true, text });
        } else {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          resolve({ success: true, text: '' });
        }
      });
    } else {
      resolve({ success: true, text: '' });
    }
  });
}

// --- One guarded execution path for voice and dashboard ---
// Do not reintroduce independent shell, AppleScript or model-selected tool handlers.
async function sendToAegis(text) {
  if (!text || !text.trim()) return;
  try {
    const body = JSON.stringify({ message: text });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: AEGIS_PORT, path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Aegis-Local': '1' }
      }, response => {
        let content = '';
        response.on('data', part => { content += part; if (content.length > 150000) req.destroy(new Error('Response too large')); });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(content);
            if (response.statusCode !== 200) reject(new Error(parsed.error || 'Aegis server failed'));
            else resolve(parsed);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(200000, () => req.destroy(new Error('Aegis server timed out')));
      req.on('error', reject);
      req.end(body);
    });
    showOverlayWithText(String(result.response || '(No response)').slice(0, 1400));
    console.log('Guarded Aegis action:', result.action);
  } catch (error) {
    console.error('Aegis request failed:', error.message);
    showOverlayWithText('Aegis unavailable: ' + error.message);
  }
}

// --- Tray Menu ---

function createTray() {
  const iconPath = path.join(__dirname, 'resources', 'aegis-icon.png');
  
  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip('Aegis Voice Control');
  
  trayInstance.on('right-click', () => {
    const sleepMenu = Menu.buildFromTemplate([
      {
        label: isAwake ? 'Sleep (Free RAM)' : 'Wake Up',
        type: 'normal',
        click: () => isAwake ? goSleep() : goAwake()
      },
      {
        label: 'Quit (Close App)',
        type: 'normal',
        click: () => app.quit()
      }
    ]);
    trayInstance.popUpContextMenu(sleepMenu);
  });
  
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!trayInstance) return;
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: isAwake ? 'Aegis Voice Control' : 'Awake - Click to Enable', 
      enabled: false 
    },
    { type: 'separator' },
    {
      label: isAwake ? `🔊 Speak to Aegis (${hotkeyFormat})` : '💤 Click to Wake Up',
      enabled: isAwake,
      click: () => startRecording()
    },
    {
      label: isAwake ? '💤 Sleep (Free RAM)' : '🔆 Wake Up',
      click: () => isAwake ? goSleep() : goAwake()
    },
    {
      label: '⚙️ Configuration',
      click: () => shell.openExternal(AEGIS_URL)
    },
    { type: 'separator' },
    { 
      label: '🔻 Quit', 
      click: () => app.quit() 
    }
  ]);
  
  trayInstance.setContextMenu(contextMenu);
}

// --- Sleep/Wake ---

function goSleep() {
  if (!isAwake) return;
  console.log('Going to sleep - freeing RAM');
  isAwake = false;
  
  if (audioProcess) {
    audioProcess.kill();
    audioProcess = null;
  }
  
  hideOverlay();
  globalShortcut.unregisterAll();
  updateTrayMenu();
}

function goAwake() {
  if (isAwake) return;
  console.log('Waking up - re-enabling shortcuts');
  isAwake = true;
  registerHotkeys();
  updateTrayMenu();
}

// --- Hotkey ---

function registerHotkeys() {
  console.log('Registering global hotkey: Option+Space');
  
  const result = globalShortcut.register('Option+Space', () => {
    startRecording();
  });
  
  if (result) {
    console.log('Hotkey registered: Option+Space');
    hotkeyFormat = 'Option+Space';
  } else {
    console.error('Failed to register hotkey');
    hotkeyFormat = 'Unavailable';
  }
}

// --- Overlay Close Handler ---

ipcMain.on('overlay-close', () => hideOverlay());
ipcMain.on('stop-recording', () => stopRecording());

// The overlay has no direct privileged tool invocation or model IPC.
// Only the server's guarded /api/chat path executes user commands.

// --- Init ---

function initialize() {
  app.dock.hide();
  if (!trayInstance) createTray();
  if (!globalShortcut.isRegistered('Option+Space')) registerHotkeys();
}

app.whenReady().then(() => initialize());

app.on('before-quit', () => {
  if (audioProcess) audioProcess.kill();
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) initialize();
});