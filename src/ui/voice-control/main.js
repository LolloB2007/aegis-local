// Aegis Voice Control - Background Process for macOS
// HOLD MODE: Press and hold Option+Space to record, release to process
// Uses 500ms debounce to detect key-up (press again within 500ms = release)

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

let isAwake = true;
let recording = false;
let audioProcess = null;
let audioFile = null;
let overlayWindow = null;
let trayInstance = null;
let hotkeyFormat = 'Option+Space';
let lastKeyPressTime = 0;
let keyUpTimer = null;

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
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  const overlayPath = path.join(__dirname, 'overlay.html');
  overlayWindow.loadFile(overlayPath);
}

function showOverlay() {
  if (!overlayWindow) {
    createOverlayWindow();
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;
  overlayWindow.setPosition(width - 340 - 10, 10);
  overlayWindow.show();
  overlayWindow.webContents.send('recording-started');
}

function hideOverlay() {
  if (keyUpTimer) {
    clearTimeout(keyUpTimer);
    keyUpTimer = null;
  }
  if (overlayWindow) {
    overlayWindow.hide();
  }
}

function showOverlayWithText(text) {
  if (!overlayWindow) {
    createOverlayWindow();
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;
  overlayWindow.setPosition(width - 340 - 10, 10);
  overlayWindow.show();
  overlayWindow.webContents.send('transcription-ready', text || '');
}

// --- Recording ---

async function startRecording() {
  if (!isAwake) return;
  if (recording) {
    // Already recording - this is likely a "key up" event (debounce)
    // Stop recording
    stopRecording();
    return;
  }
  
  // Check if this is a key-up simulation (pressed again quickly)
  const now = Date.now();
  if (now - lastKeyPressTime < 500) {
    // Simulate key-up: stop any active recording
    if (audioProcess) {
      stopRecording();
    }
    return;
  }
  
  lastKeyPressTime = now;
  
  console.log('Recording started...');
  recording = true;
  
  const timestamp = Date.now();
  audioFile = path.join(os.tmpdir(), `aegis_${timestamp}.wav`);
  
  audioProcess = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-i', ':2',
    '-t', '60',
    '-y',
    '-ar', '16000',
    '-ac', '1',
    audioFile
  ], { cwd: __dirname });
  
  audioProcess.on('close', async (code) => {
    if (code === 0 && audioFile) {
      console.log('Recording finished, processing...');
      await processAudio();
    }
    recording = false;
  });
  
  audioProcess.on('error', (err) => {
    console.error('Recording error:', err);
    recording = false;
    hideOverlay();
  });
  
  showOverlay();
}

async function stopRecording() {
  if (audioProcess) {
    audioProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  recording = false;
}

async function processAudio() {
  if (!audioFile || !fs.existsSync(audioFile)) return;
  
  try {
    const transcript = await transcribeAudio(audioFile);
    
    if (transcript.success && transcript.text.trim()) {
      console.log('Transcription:', transcript.text);
      showOverlayWithText(transcript.text);
      await sendToAegis(transcript.text);
      fs.unlinkSync(audioFile);
    } else {
      showOverlayWithText('');
    }
  } catch (err) {
    console.error('Processing error:', err);
  } finally {
    audioFile = null;
  }
}

async function transcribeAudio(filePath) {
  return new Promise((resolve) => {
    const parakeetPath = '/Users/lorenzobarbagelata/.local/bin/parakeet-transcribe';
    
    if (fs.existsSync(parakeetPath)) {
      const outputPath = path.join(os.tmpdir(), 'aegis_transcript.txt');
      const proc = spawn(parakeetPath, ['--format', 'text', '--output', outputPath, filePath]);
      
      proc.stderr.on('data', (data) => {});
      
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

async function sendToAegis(text) {
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

// --- Tray Menu ---

function createTray() {
  const { Tray } = require('electron');
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
      click: () => shell.openExternal(`${AEGIS_URL}/configuration`)
    },
    { type: 'separator' },
    { 
      label: '🔻 Quit', 
      click: () => app.quit() 
    }
  ]);
  
  trayInstance.setContextMenu(contextMenu);
}

// --- OSA Script Tools ---

ipcMain.handle('osascript-execute', async (event, script) => {
  return new Promise((resolve) => {
    const proc = spawn('/usr/bin/osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      resolve({ success: code === 0, output: stdout.trim(), error: stderr.trim() });
    });
  });
});

ipcMain.handle('system-open-app', async (event, appName) => {
  const script = `tell application "${appName}" to launch`;
  return await ipcMain.handle('osascript-execute', event, script);
});

ipcMain.handle('system-quit-app', async (event, appName) => {
  const script = `tell application "${appName}" to quit`;
  return await ipcMain.handle('osascript-execute', event, script);
});

ipcMain.handle('system-get-apps', async () => {
  const script = `tell application "System Events" to name of every process whose background is false`;
  return await ipcMain.handle('osascript-execute', null, script);
});

// --- File Operation Tools ---

ipcMain.handle('file-move', async (event, sourcePath, destPath) => {
  try {
    // Escape paths for AppleScript
    const src = sourcePath.replace(/"/g, '\\"');
    const dst = destPath.replace(/"/g, '\\"');
    const script = `tell application "Finder" to move file "${src}" to folder "${dst}"`;
    const result = await ipcMain.handle('osascript-execute', null, script);
    
    if (result.success) {
      // Also update via fs for immediate sync
      fs.copyFileSync(sourcePath, destPath);
      fs.unlinkSync(sourcePath);
      return { success: true, message: `Moved ${sourcePath} to ${destPath}` };
    }
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file-copy', async (event, sourcePath, destPath) => {
  try {
    fs.copyFileSync(sourcePath, destPath);
    return { success: true, message: `Copied ${sourcePath} to ${destPath}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file-delete', async (event, filePath) => {
  try {
    const script = `tell application "Finder" to delete file "${filePath.replace(/"/g, '\\"')}"`;
    const result = await ipcMain.handle('osascript-execute', null, script);
    
    if (result.success) {
      fs.unlinkSync(filePath);
      return { success: true, message: `Deleted ${filePath}` };
    }
    // Fallback to direct deletion
    fs.unlinkSync(filePath);
    return { success: true, message: `Deleted ${filePath}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file-rename', async (event, filePath, newName) => {
  try {
    const dir = path.dirname(filePath);
    const newPath = path.join(dir, newName);
    fs.renameSync(filePath, newPath);
    return { success: true, message: `Renamed to ${newName}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file-read-text', async (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file-write-text', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, message: `Wrote to ${filePath}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file-list', async (event, dirPath) => {
  try {
    const files = fs.readdirSync(dirPath);
    return { success: true, files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file-sort-text', async (event, filePath, order = 'asc') => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (order === 'desc') lines.reverse();
    lines.sort((a, b) => a.localeCompare(b));
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return { success: true, message: `Sorted ${filePath} (${order})` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-reorganize', async (event, action, params = {}) => {
  try {
    // Various desktop organization actions via AppleScript
    switch (action) {
      case 'clean':
        // Move all desktop files to a folder
        const script1 = `tell application "Finder" to move (every item of desktop) to folder "Desktop Cleanup" of desktop`;
        return await ipcMain.handle('osascript-execute', null, script1);
        
      case 'sort-names':
        // Sort desktop items by name
        const script2 = `tell application "Finder" to sort desktop by name`;
        return await ipcMain.handle('osascript-execute', null, script2);
        
      case 'arrange-grid':
        // Arrange desktop items in grid
        const script3 = `tell application "Finder" to set view of desktop to icon view`;
        return await ipcMain.handle('osascript-execute', null, script3);
        
      default:
        return { success: false, error: `Unknown desktop action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
});

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

ipcMain.on('overlay-close', () => {
  hideOverlay();
});

ipcMain.on('stop-recording', () => {
  stopRecording();
});

// --- Init ---

function initialize() {
  app.dock.hide();
  createTray();
  registerHotkeys();
}

app.whenReady().then(() => {
  initialize();
});

app.on('before-quit', () => {
  if (audioProcess) audioProcess.kill();
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    initialize();
  }
});