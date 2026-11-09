import { getSettings, getHistory, saveHistory } from './store.mjs';
import { classify, generate, unloadModel, isLoaded, warmKev } from './ollama.mjs';
import { APP_CHOICES, explicitIntent, detectApp, extractUrl } from './intent.mjs';
import { openApp, openWebsite, webSearch, findFiles, createNote, listNotes, timeResponse, helpText } from './tools.mjs';

const SIDE_EFFECTS = new Set(['open_app', 'open_website', 'web_search', 'find_files', 'create_note', 'list_notes']);
const EXECUTABLE = new Set([...SIDE_EFFECTS, 'get_time', 'help']);

function routeSafe(text, classification, threshold) {
  const explicit = explicitIntent(text);
  if (explicit) return { intent: explicit, reason: 'Explicit command validated', source: classification ? 'Kev + command guardrail' : 'Command fallback' };
  if (!classification) return { intent: 'ask_llm', reason: 'Kev unavailable, conversational fallback', source: 'Fallback' };
  const predicted = classification.intent;
  const confidence = classification.probability;
  if (!EXECUTABLE.has(predicted) || confidence < threshold) {
    return { intent: 'ask_llm', reason: confidence < threshold ? 'Low-confidence decision escalated' : 'Text generation requested', source: 'Kev' };
  }
  // Never execute side effects unless the user's sentence actually commands them.
  if (SIDE_EFFECTS.has(predicted)) return { intent: 'ask_llm', reason: 'No explicit command: side effect blocked', source: 'Kev + guardrail' };
  if (predicted === 'get_time' && /\btime|date|today\b/i.test(text)) return { intent: predicted, reason: 'Time request verified', source: 'Kev' };
  if (predicted === 'help' && /\b(help|capabilit|can you do)\b/i.test(text)) return { intent: predicted, reason: 'Help request verified', source: 'Kev' };
  return { intent: 'ask_llm', reason: 'No direct tool action verified', source: 'Kev + guardrail' };
}

export async function runTurn(input, hooks = {}) {
  const text = String(input || '').trim();
  if (!text || text.length > 12000) throw new Error('Enter a request between 1 and 12,000 characters.');
  const settings = await getSettings();
  const past = await getHistory();
  const history = [...past, { role: 'user', content: text, at: new Date().toISOString() }];
  const steps = [];
  const emit = (label, state = 'ok') => { const step = { label, state, at: Date.now() }; steps.push(step); hooks.onStep?.(step); };
  let classification = null;
  let classifiedError = null;
  const started = Date.now();

  if (settings.autoUnload && await isLoaded(settings, settings.llmModel)) {
    try { await unloadModel(settings, settings.llmModel, 'generator'); emit('Unloaded text model before Kev'); }
    catch (e) { emit(`Could not unload text model: ${e.message}`, 'warning'); }
  }
  try {
    classification = await classify(settings, text);
    emit(`Kev classified: ${classification.intent} (${Math.round(classification.probability * 100)}% top-choice probability)`);
  } catch (e) {
    classifiedError = e.message;
    emit(`Kev unavailable: ${e.message}`, 'warning');
  }

  const route = routeSafe(text, classification, settings.confidenceThreshold);
  let output;
  let model = settings.kevModel;
  let modelMeta = null;

  if (route.intent === 'ask_llm') {
    model = settings.llmModel;
    if (settings.autoUnload) {
      try {
        const unload = await unloadModel(settings, settings.kevModel, 'decision');
        if (unload.changed) emit('Unloaded Kev before text generation');
      } catch (e) {
        emit(`Kev unload: ${e.message}`, 'warning');
        // If Ollama is configured with MAX_LOADED_MODELS=1, its own scheduler
        // can still handle the handoff safely. Surface the warning rather than
        // permanently blocking otherwise usable installations.
        emit('Continuing handoff; Ollama may handle exclusive residency', 'warning');
      }
    }
    try {
      const result = await generate(settings, history);
      output = { text: result.content };
      modelMeta = { durationMs: result.durationMs, tokens: result.tokens, loadMs: result.loadMs };
      emit(`Generated with ${settings.llmModel}`);
    } catch (e) {
      const note = !classifiedError ? '' : ' Kev was also unavailable.';
      throw new Error(`${e.message}${note} Confirm the LLM tag in Settings and run ollama pull <model>.`);
    } finally {
      if (settings.autoReloadKev) {
        try { await warmKev(settings); emit('Re-loaded Kev for the next command'); }
        catch (e) { emit(`Kev re-load failed: ${e.message}`, 'warning'); }
      }
    }
  } else {
    switch (route.intent) {
      case 'open_app': {
        const key = detectApp(text);
        output = key && key in APP_CHOICES
          ? await openApp(key)
          : { text: `Which app? I can open: ${Object.values(APP_CHOICES).join(', ')}.`, needsInput: true };
        break;
      }
      case 'open_website': output = extractUrl(text) ? await openWebsite(text) : { text: 'Specify a URL to open.', needsInput: true }; break;
      case 'web_search': output = await webSearch(text); break;
      case 'find_files': output = await findFiles(text, settings); break;
      case 'create_note': output = await createNote(text, settings); break;
      case 'list_notes': output = await listNotes(settings); break;
      case 'get_time': output = timeResponse(); break;
      case 'help': output = { text: helpText }; break;
      default: output = { text: 'I could not determine the requested action.' };
    }
    emit(`${route.intent} executed locally${output.needsInput ? ' (needs clarification)' : ''}`);
  }

  const assistant = { role: 'assistant', content: output.text, at: new Date().toISOString(), action: route.intent, model };
  await saveHistory([...history, assistant]);
  return {
    response: output.text,
    action: route.intent,
    details: output.details || null,
    needsInput: Boolean(output.needsInput),
    route,
    classification,
    steps,
    model,
    modelMeta,
    elapsedMs: Date.now() - started,
    warning: classifiedError
  };
}
