import { spawn } from 'node:child_process';

async function parseResponse(response) {
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Ollama returned invalid JSON (${response.status}): ${text.slice(0, 200)}`); }
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}

export async function ollamaFetch(settings, endpoint, options = {}) {
  let response;
  try {
    response = await fetch(`${settings.ollamaUrl}${endpoint}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 90000)
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('Ollama request timed out. Reduce your model context or try again.');
    throw new Error(`Cannot reach Ollama at ${settings.ollamaUrl}. Is it running? (${e.message})`);
  }
  return parseResponse(response);
}

const post = (settings, endpoint, payload, timeoutMs = 90000) => ollamaFetch(settings, endpoint, {
  method: 'POST', body: JSON.stringify(payload), timeoutMs
});

export async function getOllamaStatus(settings) {
  try {
    const [tagsResult, psResult] = await Promise.allSettled([
      ollamaFetch(settings, '/api/tags', { timeoutMs: 5000 }),
      ollamaFetch(settings, '/api/ps', { timeoutMs: 5000 })
    ]);
    if (tagsResult.status === 'rejected' && psResult.status === 'rejected') throw tagsResult.reason;
    return {
      connected: true,
      installed: tagsResult.status === 'fulfilled' ? (tagsResult.value.models || []).map(m => m.name || m.model) : [],
      loaded: psResult.status === 'fulfilled' ? (psResult.value.models || []).map(m => ({ name: m.name || m.model, size: m.size, size_vram: m.size_vram, expires_at: m.expires_at })) : [],
      warning: tagsResult.status === 'rejected' ? tagsResult.reason.message : psResult.status === 'rejected' ? psResult.reason.message : null
    };
  } catch (e) {
    return { connected: false, installed: [], loaded: [], error: e.message };
  }
}

export async function isLoaded(settings, name) {
  try {
    const ps = await ollamaFetch(settings, '/api/ps', { timeoutMs: 6000 });
    return (ps.models || []).some(m => (m.name || m.model) === name);
  } catch { return false; }
}

function cliStop(name) {
  return new Promise((resolve, reject) => {
    const child = spawn('ollama', ['stop', name], { stdio: ['ignore', 'ignore', 'pipe'] });
    let detail = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 12000);
    child.stderr.on('data', data => detail += data.toString().slice(0, 250));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(detail || `ollama stop exited with ${code}`));
    });
  });
}

export async function unloadModel(settings, model, type = 'generator') {
  if (!(await isLoaded(settings, model))) return { changed: false, method: 'already-unloaded' };
  // Ollama's System One endpoint is not documented to accept keep_alive.
  // The documented CLI command is the safest way to stop a decision model.
  if (type === 'decision') {
    try { await cliStop(model); return { changed: true, method: 'ollama stop' }; }
    catch (cliError) {
      try {
        await post(settings, '/api/generate', { model, prompt: '', keep_alive: 0 }, 20000);
        return { changed: true, method: 'generate-unload' };
      } catch {
        throw new Error(`Couldn't unload Kev (${cliError.message}). Set OLLAMA_MAX_LOADED_MODELS=1 and restart Ollama, or ensure the ollama CLI is on PATH.`);
      }
    }
  }
  await post(settings, '/api/generate', { model, prompt: '', keep_alive: 0 }, 20000);
  return { changed: true, method: 'generate-unload' };
}

export const ROUTE_CRITERIA = Object.freeze({
  open_app: 'User is explicitly commanding the assistant to launch a named desktop application.',
  open_website: 'User explicitly asks to open or visit a specific URL or website.',
  web_search: 'User explicitly requests a web search in the browser.',
  find_files: 'User explicitly asks to locate a local file or filename on the computer.',
  create_note: 'User explicitly instructs the assistant to remember or save written information to a note.',
  list_notes: 'User asks to list notes already saved locally.',
  get_time: 'User requests the current local time or date.',
  ask_llm: 'User wants an explanation, conversation, summary, reasoning, or original text generated.',
  help: 'User asks what commands the assistant supports.',
  none: 'No action confidently matches, or the user is unclear.'
});

export async function classify(settings, userText) {
  const criteria = Object.fromEntries(Object.entries(ROUTE_CRITERIA));
  const appCriteria = {
    safari: 'Safari web browser', finder: 'macOS Finder file manager',
    notes: 'Apple Notes', calendar: 'Apple Calendar', reminders: 'Apple Reminders',
    mail: 'Apple Mail', music: 'Apple Music', photos: 'Apple Photos',
    terminal: 'Terminal app', vscode: 'Visual Studio Code editor',
    obsidian: 'Obsidian notes app', chrome: 'Google Chrome browser',
    settings: 'macOS System Settings', preview: 'macOS Preview app',
    none: 'No specific app was requested'
  };
  const start = Date.now();
  const result = await post(settings, '/v1/systemone', {
    model: settings.kevModel,
    state: `User instruction: ${userText.slice(0, 5500)}\nEnvironment: local macOS assistant. A tool action is appropriate only when the user explicitly requests it.`,
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Select the ONE best response type for the user instruction. Prefer ask_llm for open-ended requests and none if ambiguous.',
        criteria
      },
      target_app: {
        type: 'choice',
        instructions: 'Which exact desktop app is explicitly named as the requested launch target? Choose none if no app is mentioned.',
        criteria: appCriteria
      }
    }
  }, 90000);
  const answer = result.answers?.intent;
  if (!answer || typeof answer.choice !== 'string' || !(answer.choice in ROUTE_CRITERIA)) {
    throw new Error('Kev response did not include a valid intent classification.');
  }
  return {
    intent: answer.choice,
    probability: Number(answer.probabilities?.[answer.choice] ?? 0),
    confidence: Number(answer.confidence ?? 0),
    app: result.answers?.target_app?.choice || 'none',
    durationMs: Date.now() - start
  };
}

export async function generate(settings, history, { onDelta = null, signal = null } = {}) {
  const start = Date.now();
  const systemPrompt = `You are Aegis, a concise, helpful personal assistant running LOCALLY on a user's Mac.\n` +
    `You may explain, reason and draft text, but you DO NOT have direct access to the user's computer and cannot claim you performed actions.\n` +
    `Only the separate guarded executor can perform local actions: apps, files, vault search, Apple Calendar, Mail, Reminders, clipboard, system settings, and diagnostic information. All mutating or externally communicating new actions require explicit human approval. You CANNOT invoke these actions from this conversational response; refer the user to a direct command such as 'draft an email to ...', 'list my vault', or 'organize my Downloads' if appropriate.\n` +
    `Never claim to have changed files, sent messages, accessed private information, executed commands, or browsed the web.\n` +
    `If asked to do an unsupported action, explain the limitation and offer instructions or a draft instead.\n` +
    `Avoid fabricated specifics. Prefer direct, clear, practical answers.\n` +
    `The user may want a local assistant that handles brief commands as well as complex explanations.`;
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-settings.historyCount).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
  ];
  const request = {
    model: settings.llmModel, messages,
    stream: Boolean(onDelta),
    keep_alive: settings.autoUnload ? 0 : '5m',
    options: { num_ctx: settings.contextTokens, temperature: 0.5 }
  };
  let result;
  if (!onDelta) {
    result = await post(settings, '/api/chat', request, 180000);
  } else {
    // Ollama /api/chat emits newline-delimited JSON while stream=true.
    // Forward text incrementally to the native overlay without buffering an entire answer.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Generation timed out')), 180000);
    const abort = () => controller.abort(signal?.reason ?? new Error('Cancelled'));
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    let response;
    try {
      response = await fetch(`${settings.ollamaUrl}/api/chat`, {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify(request), signal: controller.signal
      });
      if (!response.ok) throw new Error(`Ollama generation failed (HTTP ${response.status}): ${(await response.text()).slice(0,200)}`);
      if (!response.body) throw new Error('Ollama response has no stream.');
      const decoder = new TextDecoder();
      let buffer = '', content = '', last = {};
      for await (const bytes of response.body) {
        if (signal?.aborted) throw new Error('Request cancelled');
        buffer += decoder.decode(bytes, { stream: true });
        if (buffer.length > 100000) throw new Error('Ollama streaming frame exceeded safety limit.');
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.error) throw new Error(String(message.error).slice(0,300));
          const delta = message.message?.content || '';
          if (delta) {
            content += delta;
            if (content.length > 150000) throw new Error('Generated response is too long.');
            onDelta(delta);
          }
          if (message.done) last = message;
        }
      }
      if (buffer.trim()) {
        const message = JSON.parse(buffer.trim());
        if (message.error) throw new Error(String(message.error).slice(0,300));
        const delta = message.message?.content || '';
        if (delta) { content += delta; onDelta(delta); }
        if (message.done) last = message;
      }
      result = { ...last, message: { role: 'assistant', content } };
    } catch (error) {
      if (signal?.aborted) throw new Error('Request cancelled');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    content: result.message?.content?.trim() || '(The model returned an empty response.)',
    durationMs: Date.now() - start,
    tokens: result.eval_count ?? null,
    loadMs: result.load_duration ? Math.round(result.load_duration / 1e6) : null
  };
}

export async function warmKev(settings) {
  return post(settings, '/v1/systemone', {
    model: settings.kevModel,
    state: 'A simple readiness check.',
    questions: { ready: { type: 'noul', instructions: 'Does this state describe a readiness check?' } }
  }, 90000);
}
