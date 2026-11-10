import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_CHOICES, extractUrl, extractSearch, extractNote, extractFileQuery } from './intent.mjs';
import { expandHome, inUserHome } from './store.mjs';

export function openMac(args) {
  if (process.env.AEGIS_DRY_RUN === '1') return Promise.resolve({ ok: true });
  if (process.platform !== 'darwin') throw new Error('Opening apps and links is available on macOS only.');
  return new Promise((resolve, reject) => {
    const p = spawn('open', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString().slice(0, 500); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ ok: true }) : reject(new Error(stderr.trim() || `macOS open failed (${code}).`)));
  });
}

export async function openApp(key) {
  const app = APP_CHOICES[key];
  if (!app) throw new Error('That application is not on the allowlist.');
  await openMac(['-a', app]);
  return { text: `Opened **${app}**.`, details: { app } };
}

export async function openWebsite(text) {
  const url = extractUrl(text);
  if (!url) return { text: 'Give me an exact URL, for example `open github.com`.', needsInput: true };
  await openMac([url]);
  return { text: `Opened ${url}`, details: { url } };
}

export async function webSearch(text) {
  const query = extractSearch(text);
  if (query.length < 2) return { text: 'What should I search for?', needsInput: true };
  const url = `https://www.google.com/search?q=${encodeURIComponent(query.slice(0, 400))}`;
  await openMac([url]);
  return { text: `Searched the web for **${query}** in your browser.`, details: { url } };
}

function safeBasename(name) {
  return name.replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, ' ').slice(0, 62) || 'Untitled';
}

export async function createNote(text, settings) {
  const note = extractNote(text);
  if (!note) return { text: 'Try `remember that the meeting is at 4` or `save a note: Title | Note content`.', needsInput: true };
  const dir = expandHome(settings.notesFolder);
  if (!inUserHome(dir)) throw new Error('Notes folder is outside your home directory.');
  // Resolve as far as the filesystem exists BEFORE mkdir. Otherwise a
  // configured notesFolder under the private vault could create directories
  // there even though writing the note was subsequently denied.
  let probe = path.resolve(dir), destination = null;
  for (;;) {
    try {
      const actual = await fs.realpath(probe);
      destination = path.resolve(actual, path.relative(probe, dir));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error('Unable to resolve notes directory.');
      probe = parent;
    }
  }
  const protectedDirs = [];
  for (const configured of [settings.vaultRoot, settings.memoryRoot]) {
    const original = path.resolve(expandHome(configured));
    const real = await fs.realpath(original).catch(e => {
      if (e.code === 'ENOENT') return original;
      throw e;
    });
    protectedDirs.push(original,real);
  }
  if (protectedDirs.some(root => [dir,destination].some(candidate =>
       candidate === root || candidate.startsWith(root + path.sep)))) {
    throw new Error('Protected Obsidian folders require dedicated, approved Aegis tools.');
  }
  await fs.mkdir(dir, { recursive: true });
  const actualDir = await fs.realpath(dir);
  if (!inUserHome(actualDir)) throw new Error('Notes directory points outside your home.');
  if (protectedDirs.some(root =>
        actualDir === root || actualDir.startsWith(root + path.sep))) {
    throw new Error('Protected Obsidian folders require dedicated, approved Aegis tools.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp} ${safeBasename(note.title)}.md`;
  const file = path.join(actualDir, name);
  await fs.writeFile(file, `# ${note.title.replace(/[\r\n#]/g, ' ')}\n\n${note.body}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { text: `Saved **${note.title}** to your local notes.`, details: { path: file } };
}

export async function listNotes(settings) {
  const dir = expandHome(settings.notesFolder);
  try {
    const actualDir = await fs.realpath(dir);
    if (!inUserHome(actualDir)) throw new Error('Notes directory points outside your home.');
    const entries = await fs.readdir(actualDir, { withFileTypes: true });
    const files = entries.filter(e => e.isFile() && e.name.endsWith('.md')).sort((a,b) => b.name.localeCompare(a.name)).slice(0, 12);
    if (!files.length) return { text: 'No saved notes yet. Try `remember that ...`.' };
    return { text: `**Recent notes**\n${files.map(e => `• ${e.name.replace(/^\d{4}-.*?Z\s/, '')}`).join('\n')}`, details: { folder: dir, count: files.length } };
  } catch (e) { if (e.code === 'ENOENT') return { text: 'No saved notes yet. Try `remember that ...`.' }; throw e; }
}

export async function findFiles(text, settings) {
  const query = extractFileQuery(text).toLowerCase();
  if (query.length < 2) return { text: 'What filename should I look for? Try `find files named statistics`.', needsInput: true };
  let scanned = 0;
  const found = [];
  const roots = [];
  for (const configured of settings.searchRoots) {
    const root = expandHome(configured);
    if (!inUserHome(root)) continue;
    try {
      const actual = await fs.realpath(root);
      if (inUserHome(actual)) roots.push(actual);
    } catch { /* inaccessible search root */ }
  }
  const deadline = Date.now() + 2400;
  async function walk(folder, depth) {
    if (depth > 5 || scanned >= 7000 || found.length >= 16 || Date.now() > deadline) return;
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (scanned++ >= 7000 || Date.now() > deadline || found.length >= 16) break;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = path.join(folder, e.name);
      if (e.name.toLowerCase().includes(query)) found.push({ name: e.name, path: full, kind: e.isDirectory() ? 'folder' : 'file' });
      if (e.isDirectory() && depth < 5 && !['node_modules', 'Library', '.git'].includes(e.name)) await walk(full, depth + 1);
    }
  }
  for (const root of roots) await walk(root, 0);
  if (!found.length) return { text: `No filenames matching **${query}** found in your configured folders.`, details: { scanned } };
  return { text: `Found ${found.length}${found.length >= 16 ? '+' : ''} match(es):\n${found.map(f => `• ${f.name}\n  ${f.path}`).join('\n')}`, details: { scanned, found } };
}

export function timeResponse() {
  const now = new Date();
  const locale = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { text: `It's **${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}** on **${now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}** (${locale}).` };
}

export const helpText = `I can **open apps**, **visit URLs**, **search the web in your browser**, **find filenames** in your Documents/Desktop/Downloads, **save and list local notes**, check the **time**, and **write or answer questions** using your local LLM.\n\nTry:\n• Open Obsidian\n• Search the web for inflation expectations\n• Find files named statistics\n• Remember that I need to review the project\n• List my notes\n• Explain the CAPM in 3 sentences\n\nFor anything outside these tools, I can discuss or draft it, but I won't pretend to have executed it. I do not execute shell commands or delete files.`;
