// Parameter extraction never calls a model and never turns model output into shell commands.
export const APP_CHOICES = Object.freeze({
  safari: 'Safari', finder: 'Finder', notes: 'Notes', calendar: 'Calendar',
  reminders: 'Reminders', mail: 'Mail', music: 'Music', photos: 'Photos',
  terminal: 'Terminal', vscode: 'Visual Studio Code', obsidian: 'Obsidian',
  chrome: 'Google Chrome', settings: 'System Settings', preview: 'Preview'
});

export function detectApp(text) {
  const lowered = text.toLowerCase();
  const rules = [
    ['vscode', /\b(vs\s*code|visual studio code|code editor)\b/],
    ['chrome', /\b(chrome|google chrome)\b/],
    ['settings', /\b(system settings|system preferences)\b/],
    ['safari', /\bsafari\b/], ['finder', /\bfinder\b/],
    ['calendar', /\bcalendar\b/], ['reminders', /\breminders?\b/],
    ['terminal', /\bterminal\b/], ['obsidian', /\bobsidian\b/],
    ['preview', /\bpreview\b/], ['photos', /\bphotos\b/],
    ['notes', /\bnotes\b/], ['mail', /\bmail\b/], ['music', /\bmusic\b/]
  ];
  return rules.find(([, expression]) => expression.test(lowered))?.[0] || null;
}

export function extractUrl(text) {
  const match = text.match(/\bhttps?:\/\/[^\s<>"']+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|edu|gov|it|dev|app|co|me|info|uk|fr|de)(?:\/[\w./?=&%#-]*)?/i);
  if (!match) return null;
  const candidate = match[0].replace(/[.,;!?]+$/, '');
  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

export function extractSearch(text) {
  return text.trim().replace(/^(please\s+)?(search\s+(the\s+)?(web|internet|google)\s+(for|about)?|google|look\s+up|search\s+for|find\s+online)\s*/i, '').trim().replace(/^(for|about)\s+/i, '').trim();
}

export function extractFileQuery(text) {
  return text.trim().replace(/^(please\s+)?(find|locate|search\s+for|look\s+for|where\s+is|where\s+are|show\s+me)\s*/i, '')
    .replace(/^(my\s+)?(local\s+)?(files?|documents?|folders?|named|called|with\s+(the\s+)?name)\s*/i, '')
    .replace(/^(called|named|about|containing)\s+/i, '').replace(/\s+(file|document|folder)s?\??$/i, '').trim();
}

export function extractNote(text) {
  let cleaned = text.trim().replace(/^(please\s+)?(remember\s+(that\s+)?|make\s+a\s+note\s+(that\s+)?|take\s+a\s+note\s+(that\s+)?|note\s+(that\s+)?|save\s+(a\s+)?note\s*:?\s*|write\s+(this\s+)?down\s*:?\s*)/i, '').trim();
  if (cleaned === text.trim()) return null;
  if (cleaned.length < 3) return null;
  cleaned = cleaned.slice(0, 10000);
  if (cleaned.includes('|')) {
    const [title, ...rest] = cleaned.split('|');
    return { title: title.trim().slice(0, 90), body: rest.join('|').trim() || title.trim() };
  }
  return { title: cleaned.slice(0, 58).replace(/[.!?]$/, ''), body: cleaned };
}

export function explicitIntent(text) {
  const s = text.trim().toLowerCase();
  if (/^(\/help|help|what can you do\??)$/.test(s)) return 'help';
  if (/^(what('s| is) the time|what time is it|current time|what('s| is) today('s date)?|today's date)\??$/.test(s)) return 'get_time';
  if (/^(list|show) (my )?(saved )?notes\??$/.test(s)) return 'list_notes';
  if (/^(open|launch|start)\s+/.test(s) && detectApp(text)) return 'open_app';
  if (/^(open|go to|visit|browse)\s+/.test(s) && extractUrl(text)) return 'open_website';
  if (/^(google|search (the )?(web|internet|google)|search for|look up|find online)\s+/.test(s)) return 'web_search';
  if (/^(find|locate|search for|where is|where are)\s+/.test(s) && /(file|document|pdf|folder|download|presentation|spreadsheet|\.\w{2,5})/.test(s)) return 'find_files';
  if (extractNote(text)) return 'create_note';
  return null;
}
