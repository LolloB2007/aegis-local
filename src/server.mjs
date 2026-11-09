import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, saveSettings, getHistory, clearHistory } from './store.mjs';
import { getOllamaStatus, unloadModel, warmKev } from './ollama.mjs';
import { runTurn } from './agent.mjs';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const MAX_BODY = 48 * 1024;

async function readBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json.'), { statusCode: 415 });
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY) throw Object.assign(new Error('Request too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { statusCode: 400 }); }
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
  res.end(JSON.stringify(payload));
}

function securityCheck(req, port) {
  const acceptedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!acceptedHosts.has(req.headers.host)) throw Object.assign(new Error('Invalid Host header.'), { statusCode: 403 });
  if (req.method === 'POST') {
    if (req.headers['x-aegis-local'] !== '1') throw Object.assign(new Error('Missing local-request header.'), { statusCode: 403 });
    const origin = req.headers.origin;
    if (origin && !acceptedHosts.has(new URL(origin).host)) throw Object.assign(new Error('Cross-origin request rejected.'), { statusCode: 403 });
  }
}

export function createServer({ port = Number(process.env.AEGIS_PORT) || 3210 } = {}) {
  let work = Promise.resolve();
  const enqueue = job => {
    const next = work.then(job);
    work = next.catch(() => undefined);
    return next;
  };
  const server = http.createServer(async (req, res) => {
    try {
      securityCheck(req, server.address()?.port || port);
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const [settings, history] = await Promise.all([getSettings(), getHistory()]);
        return send(res, 200, { settings, history });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const settings = await getSettings();
        return send(res, 200, await getOllamaStatus(settings));
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const { message } = await readBody(req);
        if (typeof message !== 'string' || !message.trim()) return send(res, 400, { error: 'Enter a message.' });
        return send(res, 200, await enqueue(() => runTurn(message)));
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const update = await readBody(req);
        if (!update || typeof update !== 'object' || Array.isArray(update)) return send(res, 400, { error: 'Expected settings object.' });
        const existing = await getSettings();
        let updated;
        try { updated = await saveSettings({ ...existing, ...update }); }
        catch (e) { e.statusCode = 400; throw e; }
        return send(res, 200, { settings: updated });
      }
      if (req.method === 'POST' && url.pathname === '/api/clear') {
        await readBody(req);
        await enqueue(clearHistory);
        return send(res, 200, { cleared: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/warm') {
        await readBody(req);
        return send(res, 200, await enqueue(async () => {
          const settings = await getSettings();
          if (settings.autoUnload) await unloadModel(settings, settings.llmModel);
          await warmKev(settings);
          return { warmed: true, model: settings.kevModel };
        }));
      }
      if (req.method === 'POST' && url.pathname === '/api/unload') {
        const { model } = await readBody(req);
        return send(res, 200, await enqueue(async () => {
          const settings = await getSettings();
          if (!['kev', 'llm'].includes(model)) throw Object.assign(new Error('Choose kev or llm.'), { statusCode: 400 });
          return { result: await unloadModel(settings, model === 'kev' ? settings.kevModel : settings.llmModel, model === 'kev' ? 'decision' : 'generator') };
        }));
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const target = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
        const resolved = path.resolve(publicDir, `.${target}`);
        if (!resolved.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Access denied.' });
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isFile()) return send(res, 404, { error: 'Not found.' });
        const contents = await fs.readFile(resolved);
        res.writeHead(200, {
          'content-type': types[path.extname(resolved)] || 'application/octet-stream',
          'content-length': contents.length,
          'cache-control': 'no-cache',
          'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY'
        });
        res.end(contents);
        return;
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (e) {
      const code = e.statusCode || (e.name === 'TypeError' && e.message.includes('URL') ? 400 : 500);
      console.error(`[aegis] ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) send(res, code, { error: e.message });
      else res.end();
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AEGIS_PORT) || 3210;
  const server = createServer({ port });
  server.listen(port, '127.0.0.1', () => {
    console.log('');
    console.log('  AEGIS LOCAL  //  System One + System Two');
    console.log(`  Open http://127.0.0.1:${port}`);
    console.log('  Press Ctrl+C to stop. All app data stays on this Mac.');
    console.log('');
  });
  server.on('error', e => { console.error(`Server error: ${e.message}`); process.exitCode = 1; });
}
