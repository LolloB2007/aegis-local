import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-test-')));
process.env.AEGIS_HOME = temp;
process.env.AEGIS_DRY_RUN = '1';
const { detectApp, extractUrl, extractNote, explicitIntent, extractFileQuery } = await import('../src/intent.mjs');
const { inUserHome, expandHome, saveSettings, getHistory, clearHistory } = await import('../src/store.mjs');
const { createServer } = await import('../src/server.mjs');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('intent parsing and safe URL extraction', () => {
  assert.equal(detectApp('Please open Visual Studio Code'), 'vscode');
  assert.equal(detectApp('Launch Obsidian'), 'obsidian');
  assert.equal(extractUrl('Visit github.com/test'), 'https://github.com/test');
  assert.equal(extractUrl('launch javascript:alert(1)'), null);
  assert.equal(explicitIntent('Open Safari'), 'open_app');
  assert.equal(explicitIntent('Explain bonds'), null);
  assert.equal(explicitIntent('Remember that my meeting starts at 8'), 'create_note');
  assert.deepEqual(extractNote('save a note: Stocks | Check valuation'), { title: 'Stocks', body: 'Check valuation' });
  assert.equal(extractFileQuery('Find files named statistics'), 'statistics');
});

test('home-folder isolation', () => {
  assert.equal(inUserHome('~/Documents'), true);
  assert.equal(inUserHome(path.join(temp, '..', 'escape')), false);
  assert.equal(inUserHome('/etc'), false);
  assert.equal(expandHome('~/Documents'), path.join(temp, 'Documents'));
});

test('e2e: real HTTP app, mocked Ollama, persisted Markdown notes and model handoff', async t => {
  const observed = [];
  const loaded = new Set();
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    observed.push({ endpoint: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    let payload = {};
    if (req.url === '/api/tags') payload = { models: [{ name: 'kev:0.8b-q8_0' }, { name: 'llama3.2:3b' }] };
    if (req.url === '/api/ps') payload = { models: [...loaded].map(name => ({ name })) };
    if (req.url === '/v1/systemone') {
      loaded.add(body.model);
      const input = body.state.toLowerCase();
      const intent = input.includes('explain the capm') ? 'ask_llm' : input.includes('open safari') ? 'open_app' : 'get_time';
      payload = { model: body.model, answers: { intent: { choice: intent, probabilities: { [intent]: .9 }, confidence: .85 }, target_app: { choice: 'safari', probabilities: { safari: .95 } } } };
      if (body.questions.ready) payload = { answers: { ready: { noul: .99 } } };
    }
    if (req.url === '/api/generate') { if (body.keep_alive === 0) loaded.delete(body.model); payload = { response: '', done: true }; }
    if (req.url === '/api/chat') { loaded.add(body.model); payload = { message: { role: 'assistant', content: 'CAPM relates expected return to systematic risk.' }, eval_count: 12, load_duration: 123000000 }; if (body.keep_alive === 0) loaded.delete(body.model); }
    res.end(JSON.stringify(payload));
  });
  await listen(mock);
  const mockPort = mock.address().port;
  await saveSettings({ ollamaUrl: `http://127.0.0.1:${mockPort}`, autoReloadKev: true });
  const memoryDir=path.join(temp,'Documents','Obsidian','aegis');
  await fs.mkdir(memoryDir,{recursive:true});
  await fs.writeFile(path.join(memoryDir,'Persistent memory.md'),'');
  const app = createServer({ port: 0 });
  await listen(app);
  t.after(async () => { await close(app); await close(mock); await fs.rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const get = route => fetch(`${base}${route}`, { headers: { Host: `127.0.0.1:${app.address().port}` } }).then(r => r.json());
  const post = async (route, body, overrides = {}) => {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'X-Aegis-Local': '1', 'Content-Type': 'application/json', ...overrides }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };

  const bootstrap = await get('/api/bootstrap');
  assert.equal(bootstrap.settings.kevModel, 'kev:0.8b-q8_0');
  const denied = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  const crossOrigin = await post('/api/chat', { message: 'Open Safari' }, { Origin: 'http://evil.test' });
  assert.equal(crossOrigin.status, 403);

  const appOpen = await post('/api/chat', { message: 'Open Safari' });
  assert.equal(appOpen.status, 200);
  assert.equal(appOpen.json.action, 'open_app');
  assert.match(appOpen.json.response, /Opened/);

  const saved = await post('/api/chat', { message: 'Remember that I should revise econometrics' });
  assert.equal(saved.json.action, 'memory_remember');
  assert.equal(saved.json.needsInput, true);
  const persistent = path.join(temp, 'Documents', 'Obsidian', 'aegis', 'Persistent memory.md');
  assert.equal(await fs.readFile(persistent,'utf8'), '', 'Nothing written before confirmation.');
  const approved = await post('/api/chat', {
    message: 'confirm ' + saved.json.details.confirmationToken
  });
  assert.equal(approved.json.action, 'memory_remember');
  assert.match(await fs.readFile(persistent,'utf8'), /revise econometrics/);

  const explanation = await post('/api/chat', { message: 'Explain the CAPM' });
  assert.equal(explanation.status, 200);
  assert.equal(explanation.json.action, 'ask_llm');
  assert.match(explanation.json.response, /systematic risk/);
  assert.ok(observed.some(event => event.endpoint === '/api/chat' && event.body.keep_alive === 0));
  assert.ok(observed.some(event => event.endpoint === '/api/generate' && event.body.model === 'kev:0.8b-q8_0' && event.body.keep_alive === 0));
  assert.equal(loaded.has('kev:0.8b-q8_0'), false, 'Kev must not be re-warmed while autoUnload is enabled');
  assert.equal(loaded.has('llama3.2:3b'), false, 'LLM unloaded');

  const history = await getHistory();
  assert.equal(history.length, 8);
  assert.equal(history.at(-1).role, 'assistant');
  const unsupported = await post('/api/settings', { notesFolder: '/etc' });
  assert.equal(unsupported.status, 400);
  assert.match(unsupported.json.error, /inside your home folder/);
  const cleared = await post('/api/clear', {});
  assert.equal(cleared.json.cleared, true);
  assert.equal((await getHistory()).length, 0);
});
