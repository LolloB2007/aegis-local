// Aegis Voice Control v1.2.0 - Tool Chain System
// Implements async LLM parameter generation within tool calls

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
  if (!overlayWindow) createOverlayWindow();
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow.setPosition(width - 340 - 10, 10);
  overlayWindow.show();
  overlayWindow.webContents.send('recording-started');
}

function hideOverlay() {
  if (overlayWindow) overlayWindow.hide();
}

function showOverlayWithText(text) {
  if (!overlayWindow) createOverlayWindow();
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow.setPosition(width - 340 - 10, 10);
  overlayWindow.show();
  overlayWindow.webContents.send('transcription-ready', text || '');
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
  
  showOverlay();
}

async function stopRecording() {
  if (audioProcess) {
    audioProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  recording = false;
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
      
      proc.stderr.on('data', () => {});
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

// --- Tool Chain System ---

// Detect if transcription is a tool call format
function isToolCall(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed.tool && typeof parsed.tool === 'string';
  } catch {
    return false;
  }
}

// Generate content via local LLM for tool parameters
async function generateLlmContent(prompt) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.response) {
            resolve({ success: true, content: parsed.response });
          } else if (parsed.error) {
            resolve({ success: false, error: parsed.error });
          } else {
            resolve({ success: false, error: 'Unknown response format' });
          }
        } catch {
          resolve({ success: false, error: 'Failed to parse LLM response' });
        }
      });
    });
    
    req.on('error', err => {
      resolve({ success: false, error: err.message });
    });
    
    const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';
    
    req.write(JSON.stringify({
      model,
      prompt,
      stream: false,
      keep_alive: 0
    }));
    req.end();
  });
}

async function executeOsascript(script) {
  return new Promise((resolve) => {
    const proc = spawn('/usr/bin/osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      resolve({ success: code === 0, output: stdout.trim(), error: stderr.trim() });
    });
  });
}

// Tool handlers
const toolHandlers = {
  // Application tools
  'open-app': async (params) => {
    const appName = params.app || params.name;
    if (!appName) return { success: false, error: 'No app name specified' };
    const script = `tell application "${appName}" to launch`;
    return await executeOsascript(script);
  },
  
  'quit-app': async (params) => {
    const appName = params.app || params.name;
    if (!appName) return { success: false, error: 'No app name specified' };
    const script = `tell application "${appName}" to quit`;
    return await executeOsascript(script);
  },
  
  // Email tools
  'send-email': async (params) => {
    const recipient = params.to || params.recipient;
    const subject = params.subject || 'Email from Voice Control';
    const body = params.body || params.content || '';
    
    if (!recipient) return { success: false, error: 'No recipient specified' };
    
    if (!body && params.generate_body) {
      const genResult = await generateLlmContent(params.generate_body);
      if (genResult.success) {
        params.body = genResult.content;
      }
    }
    
    if (!params.body) {
      return { success: false, error: 'No email content' };
    }
    
    const script = `
      tell application "Microsoft Outlook"
        make new outgoing message with properties {subject:"${subject}", content:"${body.replace(/"/g, '\\"')}"}
        activate
      end tell`;
    
    return await executeOsascript(script);
  },
  
  // File tools
  'sort-file': async (params) => {
    const filePath = params.path || params.file;
    const order = params.order || 'asc';
    
    if (!filePath) return { success: false, error: 'No file path specified' };
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (order === 'desc') lines.reverse();
    lines.sort((a, b) => a.localeCompare(b));
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    
    return { success: true, message: `Sorted ${filePath}` };
  },
  
  'delete-file': async (params) => {
    const filePath = params.path || params.file;
    if (!filePath) return { success: false, error: 'No file path specified' };
    
    try {
      fs.unlinkSync(filePath);
      return { success: true, message: `Deleted ${filePath}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  
  // Desktop tools
  'reorganize-desktop': async (params) => {
    const action = params.action || 'clean';
    
    switch (action) {
      case 'clean':
        return await executeOsascript('tell application "Finder" to move (every item of desktop) to folder "Desktop Cleanup" of desktop');
      case 'sort':
        return await executeOsascript('tell application "Finder" to sort desktop by name');
      default:
        return { success: false, error: `Unknown desktop action: ${action}` };
    }
  },
  
  // Calendar tools
  'create-calendar-event': async (params) => {
    const title = params.title || params.name;
    const startDate = params.start || params.date;
    const endDate = params.end || params.due;
    const calendar = params.calendar || 'Home';
    
    if (!title) return { success: false, error: 'No event title specified' };
    if (!startDate) return { success: false, error: 'No start date specified' };
    
    const script = `
      tell application "Calendar"
        tell calendar "${calendar}"
          make new event with properties {summary:"${title}", start date:date "${startDate}"${endDate ? ', end date:date "' + endDate + '"' : ''}}
        end tell
        activate
      end tell`;
    
    return await executeOsascript(script);
  },
  
  'schedule-meeting': async (params) => {
    const title = params.title || 'Meeting';
    const participants = params.with || params.participants || '';
    const when = params.when || params.time || 'today at 3pm';
    const duration = params.duration || 1;
    
    if (!participants) return { success: false, error: 'No participants specified' };
    
    const genPrompt = `Create a calendar event for a meeting titled "${title}" with ${participants}. 
The meeting is ${when} and will last ${duration} hour(s). 
Generate the iCal-like format with all details needed for Apple Calendar.`;
    
    const genResult = await generateLlmContent(genPrompt);
    if (!genResult.success) {
      return { success: false, error: `Failed to generate meeting details: ${genResult.error}` };
    }
    
    return await toolHandlers['create-calendar-event']({
      title,
      start: when,
      duration: `${duration} hour`,
      notes: genResult.content
    });
  },
  
  'list-calendar-events': async (params) => {
    const calendar = params.calendar || 'Home';
    const days = parseInt(params.days) || 7;
    const script = `
      tell application "Calendar"
        set startDate to (current date)
        set endDate to startDate + (${days} * days)
        set eventList to {}
        tell calendar "${calendar}"
          repeat with thisEvent in (every event whose start date ≥ startDate and start date ≤ endDate)
            set end of eventList to {summary of thisEvent, start date of thisEvent, end date of thisEvent}
          end repeat
        end tell
      end tell`;
    return await executeOsascript(script);
  },
  
  // Clipboard tools
  'clipboard-read': async () => {
    return new Promise((resolve) => {
      const script = 'the clipboard as «class utf8»';
      const proc = spawn('/usr/bin/osascript', ['-e', script]);
      let stdout = '';
      
      proc.stdout.on('data', data => { stdout += data.toString(); });
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, content: stdout.trim() });
        } else {
          resolve({ success: false, error: 'Failed to read clipboard' });
        }
      });
    });
  },
  
  'clipboard-write': async (params) => {
      const content = params.content || params.text || params.value || '';
      const script = `set the clipboard to "${content.replace(/"/g, '\\"')}"`;
    const result = await executeOsascript(script);
    if (result.success) {
      return { success: true, message: 'Content copied to clipboard' };
    }
    return result;
  },
  
  // Shell execution (with safety wrapper)
  'shell-execute': async (params) => {
    const command = params.command || params.cmd;
    if (!command) return { success: false, error: 'No command specified' };
    
    const allowed = [
      'ls', 'cat', 'head', 'tail', 'which', 'pwd', 'date',
      'open', 'osascript', 'say', 'pbcopy', 'pbpaste',
      'du', 'df', 'free', 'top', 'networksetup', 'ipconfig'
    ];
    
    const cmdBase = command.split(' ')[0];
    const isAllowed = allowed.some(allowedCmd => {
      if (allowedCmd.includes(' ')) return allowedCmd === cmdBase;
      return cmdBase === allowedCmd || cmdBase.endsWith('/' + allowedCmd) || cmdBase.includes(allowedCmd);
    });
    
    if (!isAllowed) {
      return { success: false, error: 'Command not allowed: ' + cmdBase };
    }
    
    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', command]);
      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ success: false, error: 'Command timed out (5s limit)' });
      }, 5000);
      
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', data => { stdout += data.toString(); });
      proc.stderr.on('data', data => { stderr += data.toString(); });
      
      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ 
          success: code === 0, 
          output: stdout.trim(), 
          error: stderr.trim() || undefined 
        });
      });
    });
  },
  
  // System info tools
  'get-battery-status': async () => {
    const script = `
      tell application "System Events"
        get value of attribute "preparingShopper"
      end tell`;
    
    // Use pmset for battery info
    return new Promise((resolve) => {
      spawn('bash', ['-c', 'pmset -g batt | grep -o "[0-9]*%" | head -1'], {
        stdio: ['ignore', 'pipe', 'ignore']
      }).stdout.on('data', (data) => {
        const percent = data.toString().trim();
        spawn('bash', ['-c', 'pmset -g batt | grep -q "discharging" && echo "discharging" || echo "charging"'], {
          stdio: ['ignore', 'pipe', 'ignore']
        }).stdout.on('data', (statusData) => {
          const status = statusData.toString().trim();
          spawn('bash', ['-c', 'system_profiler SPPowerDataType | grep "Condition" | head -1'], {
            stdio: ['ignore', 'pipe', 'ignore']
          }).stdout.on('data', (condData) => {
            resolve({ 
              success: true, 
              battery: {
                percent: parseInt(percent) || 0,
                status: status,
                condition: condData.toString().trim()
              }
            });
          });
        });
      });
    });
  },
  
  'get-network-info': async () => {
    return new Promise((resolve) => {
      const results = {};
      
      // Get IP
      spawn('bash', ['-c', 'ipconfig getifaddr en0 2>/dev/null || echo "no-ip"'], {
        stdio: ['ignore', 'pipe', 'ignore']
      }).stdout.on('data', (data) => {
        results.ip = data.toString().trim();
        
        // Get WiFi status
        spawn('bash', ['-c', 'networksetup -getairportpower en0 2>/dev/null || echo "unknown"'], {
          stdio: ['ignore', 'pipe', 'ignore']
        }).stdout.on('data', (wifiData) => {
          const wifiInfo = wifiData.toString().trim();
          const wifiOn = wifiInfo.includes('On');
          
          // Get SSID if connected
          spawn('bash', ['-c', 'networksetup -getairportnetwork en0 2>/dev/null | sed "s/Yours is: //" || echo "not-connected"'], {
            stdio: ['ignore', 'pipe', 'ignore']
          }).stdout.on('data', (ssidData) => {
            const ssid = ssidData.toString().trim();
            
            resolve({
              success: true,
              network: {
                ip: results.ip,
                wifi: wifiOn ? 'on' : 'off',
                ssid: ssid.includes('not-connected') ? null : ssid
              }
            });
          });
        });
      });
    });
  },
  
  'set-volume': async (params) => {
    const level = parseInt(params.level) || params.value || 50;
    if (level < 0 || level > 100) return { success: false, error: 'Volume must be 0-100' };
    
    const script = `tell application "System Events" to set volume output volume ${level}`;
    const result = await executeOsascript(script);
    
    if (result.success) {
      return { success: true, message: 'Volume set to ' + level + '%' };
    }
    return result;
  },
  
  'set-brightness': async (params) => {
    const level = parseInt(params.level) || params.value || 50;
    if (level < 0 || level > 100) return { success: false, error: 'Brightness must be 0-100' };
    
    const script = `tell application "System Events" to set screen brightness of every display to ${level / 100}`;
    const result = await executeOsascript(script);
    
    if (result.success) {
      return { success: true, message: 'Brightness set to ' + level + '%' };
    }
    return result;
  },
  
  // Transcribe tool (self-referential)
  'transcribe': async (params) => {
    return { success: true, type: 'transcription', data: params.text || '' };
  }
};

// Run tool chain from transcription
async function runToolChain(text) {
  if (!isToolCall(text)) {
    await sendToAegis(text);
    return;
  }
  
  let toolDef;
  try {
    toolDef = JSON.parse(text);
  } catch {
    await sendToAegis(text);
    return;
  }
  
  const toolName = toolDef.tool;
  const params = toolDef.params || {};
  const handler = toolHandlers[toolName];
  
  if (!handler) {
    await sendToAegis(`Unknown tool: ${toolName}`);
    return;
  }
  
  if (params.generate_from) {
    showOverlayWithText(`Generating: ${params.generate_from}`);
    const genResult = await generateLlmContent(params.generate_from);
    if (genResult.success) {
      Object.assign(params, genResult.content);
    } else {
      await sendToAegis(`Failed to generate: ${genResult.error}`);
      return;
    }
  }
  
  showOverlayWithText(`Executing: ${toolName}`);
  const result = await handler(params);
  
  if (result.success) {
    await sendToAegis(`Tool "${toolName}" completed: ${JSON.stringify(result)}`);
  } else {
    await sendToAegis(`Tool "${toolName}" failed: ${result.error}`);
  }
}

// Send to Aegis API
async function sendToAegis(text) {
  if (!text.trim()) return;
  
  const payload = JSON.stringify({ message: text });
  const req = http.request({
    hostname: '127.0.0.1',
    port: AEGIS_PORT,
    path: '/api/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Aegis-Local': '1'
    }
  }, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log('✓ Sent to Aegis:', text.substring(0, 50) + '...');
      } else {
        console.error('✗ Aegis API error:', res.statusCode);
      }
    });
  });
  
  req.on('error', err => {
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

// --- Tool Chain IPC Handlers ---

ipcMain.handle('execute-tool', async (event, toolDef) => {
  const toolName = toolDef.tool;
  const params = toolDef.params || {};
  const handler = toolHandlers[toolName];
  
  if (!handler) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }
  
  return await handler(params);
});

ipcMain.handle('generate-content', async (event, prompt) => {
  return await generateLlmContent(prompt);
});

ipcMain.handle('list-tools', async () => {
  return {
    success: true,
    tools: Object.keys(toolHandlers),
    categories: {
      apps: ['open-app', 'quit-app'],
      email: ['send-email'],
      file: ['sort-file', 'delete-file'],
      desktop: ['reorganize-desktop'],
      calendar: ['create-calendar-event', 'schedule-meeting', 'list-calendar-events'],
      system: ['clipboard-read', 'clipboard-write', 'shell-execute', 'get-battery-status', 'get-network-info', 'set-volume', 'set-brightness'],
      other: ['transcribe']
    }
  };
});

// --- Init ---

function initialize() {
  app.dock.hide();
  createTray();
  registerHotkeys();
}

app.whenReady().then(() => initialize());

app.on('before-quit', () => {
  if (audioProcess) audioProcess.kill();
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) initialize();
});