import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = process.env.AEGIS_HOME || os.homedir();
const dataDir = path.join(home, '.aegis-local');
const configPath = path.join(dataDir, 'settings.json');
const historyPath = path.join(dataDir, 'history.json');

export const defaults = Object.freeze({
  kevModel: 'kev:0.8b-q8_0',
  llmModel: 'llama3.2:3b',
  ollamaUrl: 'http://127.0.0.1:11434',
  autoUnload: true,
  autoReloadKev: true,
  confidenceThreshold: 0.55,
  contextTokens: 2048,
  historyCount: 12,
  searchRoots: ['~/Documents', '~/Desktop', '~/Downloads'],
  notesFolder: '~/Documents/Aegis Notes',
  vaultRoot: '~/Documents/Obsidian/claude',
  calendarName: '',
  reminderListName: ''
});

export const expandHome = value => typeof value === 'string'
  ? (value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(value))
  : home;

export function inUserHome(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  return resolved === home || resolved.startsWith(`${home}${path.sep}`);
}

function assertLocalUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Ollama URL must be a valid URL.'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Ollama must be accessed through a local HTTP address only (for example http://127.0.0.1:11434).');
  }
  return parsed.origin;
}

export function validateSettings(raw) {
  const v = { ...defaults, ...raw };
  for (const name of ['kevModel', 'llmModel']) {
    if (typeof v[name] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,120}$/.test(v[name]) || v[name].includes('..') || v[name].endsWith(':cloud')) {
      throw new Error(`Invalid ${name}. Local Ollama model tags only.`);
    }
  }
  if (v.kevModel === v.llmModel) throw new Error('The decision model and text generator must use separate model tags.');
  v.ollamaUrl = assertLocalUrl(v.ollamaUrl);
  v.autoUnload = Boolean(v.autoUnload);
  v.autoReloadKev = Boolean(v.autoReloadKev);
  v.confidenceThreshold = Math.max(0.30, Math.min(0.95, Number(v.confidenceThreshold) || defaults.confidenceThreshold));
  v.contextTokens = Math.max(512, Math.min(8192, Math.round(Number(v.contextTokens) || defaults.contextTokens)));
  v.historyCount = Math.max(2, Math.min(24, Math.round(Number(v.historyCount) || defaults.historyCount)));
  if (!Array.isArray(v.searchRoots) || v.searchRoots.length > 8 || !v.searchRoots.every(x => typeof x === 'string' && inUserHome(x))) {
    throw new Error('Search folders must be inside your home folder (maximum 8).');
  }
  if (typeof v.notesFolder !== 'string' || !inUserHome(v.notesFolder)) {
    throw new Error('Notes folder must be inside your home folder.');
  }
  if (typeof v.vaultRoot !== 'string' || !inUserHome(v.vaultRoot)) {
    throw new Error('Vault folder must be inside your home directory.');
  }
  for (const key of ['calendarName', 'reminderListName']) {
    if (typeof v[key] !== 'string' || v[key].length > 100 || /[\\r\\n\\u0000]/.test(v[key])) {
      throw new Error(`Invalid ${key}. Use an exact macOS calendar or Reminders list name.`);
    }
    v[key] = v[key].trim();
  }
  return v;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJson(file, obj) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}
export const getSettings = async () => validateSettings(await readJson(configPath, {}));
export const saveSettings = async values => {
  const settings = validateSettings(values);
  await writeJson(configPath, settings);
  return settings;
};
export const getHistory = async () => {
  const value = await readJson(historyPath, []);
  return Array.isArray(value) ? value.slice(-100) : [];
};
export const saveHistory = async messages => writeJson(historyPath, messages.slice(-100));
export const clearHistory = async () => writeJson(historyPath, []);
export const paths = { home, dataDir, configPath, historyPath };
