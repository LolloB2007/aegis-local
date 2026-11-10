import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, saveSettings, getHistory, clearHistory } from './store.mjs';
import { getOllamaStatus, unloadModel, warmKev } from './ollama.mjs';
import { runTurn } from './agent.mjs';
import { createModelScheduler } from './model-lifecycle.mjs';
import { initializeStartupContext, getStartupContext } from './startup-context.mjs';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const MAX_BODY = 48 * 1024;
const VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(publicDir, '..', 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
})();

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
    if (origin) {
      let parsed;
      try { parsed = new URL(origin); }
      catch { throw Object.assign(new Error('Invalid Origin header.'), { statusCode: 403 }); }
      if (parsed.protocol !== 'http:' || !acceptedHosts.has(parsed.host) || parsed.origin !== `http://${parsed.host}`) {
        throw Object.assign(new Error('Cross-origin request rejected.'), { statusCode: 403 });
      }
    }
  }
}

export function createServer({ port = Number(process.env.AEGIS_PORT) || 3210, startup = null } = {}) {
  // No chat endpoint becomes usable until Persistent memory.md was read.
  const readiness = (startup || (async()=>initializeStartupContext(await getSettings()))())
    .then(value=>({ok:true,context:value}))
    .catch(e=>({ok:false,error:e.message}));
  // Offload the Aegis models after EACH completed/failed request, not two
  // minutes later. The scheduler serializes requests with model cleanup.
  const lifecycle = createModelScheduler({
    readSettings:getSettings,
    unload:unloadModel,
    report:message=>console.warn('[aegis] '+message)
  });
  const enqueue = lifecycle.enqueue;

  const server = http.createServer(async (req, res) => {
    try {
      securityCheck(req, server.address()?.port || port);
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const ready = await readiness;
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(res,ready.ok?200:503,{
          ok:ready.ok,service:'aegis-core',version:VERSION,
          startup:ready.ok?{promptLoaded:ready.context.promptLoaded,memoryLoaded:true,memoryCharacters:ready.context.memoryCharacters,loadedAt:ready.context.loadedAt}:
          {error:ready.error}
        });
      }
      if(!ready.ok && (url.pathname==='/api/chat'||url.pathname==='/api/stream'||
          url.pathname==='/api/warm'||url.pathname==='/api/unload')) {
        return send(res,503,{error:'Aegis startup incomplete: '+ready.error});
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const [settings, history] = await Promise.all([getSettings(), getHistory()]);
        return send(res, 200, { settings, history });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const settings = await getSettings();
        return send(res, 200, await getOllamaStatus(settings));
      }
      if (req.method === 'POST' && url.pathname === '/api/stream') {
        const { message } = await readBody(req);
        if (typeof message !== 'string' || !message.trim() || message.length > 12000)
          return send(res,400,{error:'Enter a request between 1 and 12,000 characters.'});
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          'connection': 'keep-alive',
          'x-content-type-options':'nosniff',
          'x-accel-buffering':'no'
        });
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        const event = (type, value) => {
          if (controller.signal.aborted || res.writableEnded || res.destroyed) return;
          res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
        };
        const heartbeat = setInterval(() => {
          if (!controller.signal.aborted && !res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
        }, 12000);
        event('phase', {state:'queued',label:'Waiting for the local model queue'});
        try {
          const result = await enqueue(() => {
            if (controller.signal.aborted) throw new Error('Request cancelled');
            event('phase',{state:'running',label:'Kev deciding how to route the request'});
            return runTurn(message, {
              signal:controller.signal,
              onStep:step=>event('step',step),
              onDelta:text=>event('delta',{text})
            });
          });
          event('result', result);
          event('done',{ok:true});
        } catch(e) {
          event('error',{error:String(e.message||e).slice(0,500)});
          event('done',{ok:false});
        } finally {
          clearInterval(heartbeat);
          if(!res.writableEnded) res.end();
        }
        return;
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
        let target;
        try { target = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); }
        catch { return send(res, 400, { error: 'Malformed URL.' }); }
        const resolved = path.resolve(publicDir, `.${target}`);
        if (!resolved.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Access denied.' });
        const actual = await fs.realpath(resolved).catch(() => null);
        if (!actual) return send(res, 404, { error: 'Not found.' });
        if (!actual.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Access denied.' });
        const stat = await fs.stat(actual).catch(() => null);
        if (!stat?.isFile()) return send(res, 404, { error: 'Not found.' });
        const contents = await fs.readFile(actual);
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
  server.on('close', () => lifecycle.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // launchd appends every run to the same log file; timestamp each line.
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(new Date().toISOString(), ...args);
  }
  const port = Number(process.env.AEGIS_PORT) || 3210;
  // Strict startup gate: an existing, possibly EMPTY Persistent memory.md
  // must have been successfully read before the assistant listens for requests.
  const launch = async () => {
    try {
      const ready = await initializeStartupContext(await getSettings());
      console.log('[aegis] Startup context loaded: prompt='+
        (ready.promptLoaded?'yes':'fallback')+', persistent memory='+ready.memoryCharacters+' characters');
      const server = createServer({port,startup:Promise.resolve(ready)});
      server.listen(port,'127.0.0.1',()=> {
        console.log(`AEGIS LOCAL ${VERSION} // Listening at http://127.0.0.1:${port}`);
      });
      server.on('error',e=>{console.error('[aegis] Server:',e.message);process.exitCode=1;});
    } catch(e) {
      console.error('[aegis] Not ready:',e.message);
      process.exitCode=1;
    }
  };
  launch();
}
