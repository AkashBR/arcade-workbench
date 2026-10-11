// AI model connections. Two wire formats cover almost every provider:
// "openai" (chat/completions, used by OpenAI and everything compatible with it) and "anthropic" (messages).
const PRESETS = [
  { id: 'openai', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', env: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', env: 'ANTHROPIC_API_KEY', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', kind: 'openai', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', env: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', kind: 'openai', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', env: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', kind: 'openai', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: '', env: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys' },
  { id: 'ollama', kind: 'openai', name: 'Ollama (on this machine)', baseUrl: 'http://localhost:11434/v1', model: '', env: null, noKey: true },
  { id: 'custom', kind: 'openai', name: 'Custom (OpenAI-compatible)', baseUrl: '', model: '', env: null },
];
const preset = (id) => PRESETS.find((p) => p.id === id) || null;

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
function headersFor(conn, key) {
  if (conn.kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  return { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' };
}
async function call(url, init) {
  let res;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(90000) }); }
  catch (e) { const err = new Error(`Could not reach ${new URL(url).host}: ${e.cause?.code || e.name || e.message}`); err.status = 502; throw err; }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const detail = body?.error?.message || body?.error || body?.message || text.slice(0, 300) || 'no details';
    const err = new Error(`${res.status} from the provider: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// One question, one answer. Returns the reply text.
async function chat(conn, key, { system, user }) {
  if (!conn.model) { const e = new Error('Choose a model for this connection first.'); e.status = 400; throw e; }
  const base = trimUrl(conn.base_url);
  if (conn.kind === 'anthropic') {
    const body = await call(`${base}/v1/messages`, { method: 'POST', headers: headersFor(conn, key),
      body: JSON.stringify({ model: conn.model, max_tokens: 1500, ...(system ? { system } : {}), messages: [{ role: 'user', content: user }] }) });
    return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  // No token limit or temperature: providers disagree on those fields, and the prompts here ask for short replies.
  const body = await call(`${base}/chat/completions`, { method: 'POST', headers: headersFor(conn, key),
    body: JSON.stringify({ model: conn.model, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }] }) });
  const content = body.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((c) => c.text || '').join('') : String(content || '');
}

async function listModels(conn, key) {
  const base = trimUrl(conn.base_url);
  const body = await call(conn.kind === 'anthropic' ? `${base}/v1/models?limit=100` : `${base}/models`, { method: 'GET', headers: headersFor(conn, key) });
  return (body.data || body.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
}

// The brief the model gets when someone asks for prompt ideas. It carries Arcade's rules,
// so suggestions are ones the API will accept.
function suggestBrief({ world, category, materials, idea, count }) {
  const n = Math.min(8, Math.max(1, Number(count) || 4));
  const system = 'You write prompts for Arcade, a service that turns a text prompt into a manufactured physical product. '
    + 'Reply with JSON only: an array of objects, each with "title" (3 to 5 words) and "prompt" (one or two sentences, under 400 characters). No markdown, no commentary.';
  const rules = world === 'jewelry'
    ? `The product is a piece of jewelry in the category "${category || 'jewelry'}". Each prompt must fit that category and name exactly one metal`
      + (materials?.length ? ` from this list: ${materials.join(', ')}.` : '.')
      + ' Describe shape, finish and details a jeweler can make. Say "no stones" unless the idea asks for stones. Do not mention models, photos, backgrounds or packaging.'
    : `The product is a printed good${category ? ` in the category "${category}"` : ''}. Each prompt describes flat artwork or a surface pattern: motif, style, colors, scale and ground. `
      + 'Do not describe the product itself, photos or mockups.';
  const user = `${rules}\n\nIdea from the user: ${String(idea || '').trim() || 'none given, so offer commercially appealing options that differ from each other'}\n\nWrite ${n} different prompts.`;
  return { system, user };
}
function parseSuggestions(reply) {
  const a = reply.indexOf('['), b = reply.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('The model did not return a list. Try again, or try another model.');
  const items = JSON.parse(reply.slice(a, b + 1));
  return items.filter((x) => x && x.prompt).map((x) => ({ title: String(x.title || 'Untitled').slice(0, 80), prompt: String(x.prompt).slice(0, 1000) }));
}

module.exports = { PRESETS, preset, chat, listModels, suggestBrief, parseSuggestions };
