// AI model connections. Two wire formats cover almost every provider:
// "openai" (chat/completions, used by OpenAI and everything compatible with it) and "anthropic" (messages).
const PRESETS = [
  // The first three are fully set up: a person only adds a key. OPENAI_BASE_URL, ANTHROPIC_BASE_URL and GEMINI_BASE_URL point them at a proxy.
  // OpenAI and Gemini have no fixed model here: the newest small model on the account is picked when the key is first tested.
  { id: 'openai', kind: 'openai', name: 'OpenAI', short: 'OpenAI', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', model: '', env: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', kind: 'anthropic', name: 'Anthropic (Claude)', short: 'Claude', baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', model: 'claude-opus-5-5', env: 'ANTHROPIC_API_KEY', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', kind: 'openai', name: 'Google Gemini', short: 'Gemini', baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', env: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', kind: 'openai', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', env: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', kind: 'openai', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: '', env: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys' },
  { id: 'ollama', kind: 'openai', name: 'Ollama (on this machine)', baseUrl: 'http://localhost:11434/v1', model: '', env: null, noKey: true },
  { id: 'custom', kind: 'openai', name: 'Custom (OpenAI-compatible)', baseUrl: '', model: '', env: null },
];
const preset = (id) => PRESETS.find((p) => p.id === id) || null;
// Claude models that accept the server-side refusal fallback.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// If a preset's model is not on the account, pick the best one that is, in this order.
const PREFER = {
  openai: [/^gpt-5(\.\d+)?-mini$/, /^gpt-5(\.\d+)?$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/, /^gpt-4o$/, /^gpt-/],
  anthropic: [/^claude-opus-5-5$/, /^claude-sonnet-5-5$/, /^claude-haiku-5-5$/, /^claude-opus/, /^claude-sonnet/, /^claude-/],
  gemini: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-flash/, /^gemini-/],
};
// The workbench only writes text with these models so far, so models that make images, audio, video or embeddings are left out.
const NOT_TEXT = /(image|dall-e|imagen|embed|whisper|tts|audio|realtime|moderation|transcribe|sora|veo|video|search|computer-use|rerank|aqa|lyria|learnlm|robotics|babbage|davinci|instruct)/i;
const isTextModel = (id) => !NOT_TEXT.test(id);

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
    // Thinking is left at the model's default (adaptive), and it shares max_tokens with the answer, so leave room.
    // On Anthropic's own API, a request its safety checks decline is retried on the model Anthropic recommends.
    const fallback = FALLBACK_MODELS.has(conn.model) && /(^|\.)anthropic\.com$/.test(new URL(base).host);
    const body = await call(`${base}/v1/messages`, { method: 'POST',
      headers: { ...headersFor(conn, key), ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) },
      body: JSON.stringify({ model: conn.model, max_tokens: 16000, ...(fallback ? { fallbacks: 'default' } : {}), ...(system ? { system } : {}), messages: [{ role: 'user', content: user }] }) });
    if (body.stop_reason === 'refusal') {
      const e = new Error(`Claude declined this request${body.stop_details?.category ? ` (${body.stop_details.category})` : ''}. Reword it and try again.`);
      e.status = 422;
      throw e;
    }
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

async function resolveModel(conn, key) {
  const ids = (await listModels(conn, key)).filter(isTextModel);
  for (const re of PREFER[conn.preset] || []) {
    const hit = ids.filter((id) => re.test(id)).sort().pop();
    if (hit) return hit;
  }
  return ids[0] || '';
}
// One small real request. If the connection's model is not available, find one that is and say which.
async function connectTest(conn, key, { exact = false } = {}) {
  const started = Date.now();
  const ask = (model) => chat({ ...conn, model }, key, { user: 'Reply with the single word: ready' });
  const done = (model, reply) => ({ ok: true, model, reply: reply.trim().slice(0, 300) || '(the model returned no text)', ms: Date.now() - started });
  try {
    try { return done(conn.model, await ask(conn.model)); }
    catch (e) {
      if (exact || e.status === 401 || e.status === 403) throw e; // a wrong key, or a model the person chose: another model will not help
      const picked = await resolveModel(conn, key).catch(() => '');
      if (!picked || picked === conn.model) throw e;
      return done(picked, await ask(picked));
    }
  } catch (e) { return { ok: false, error: e.message, status: e.status || null, ms: Date.now() - started }; }
}

module.exports = { PRESETS, PREFER, preset, chat, listModels, isTextModel, resolveModel, connectTest, suggestBrief, parseSuggestions };
