// Workbench server. No dependencies: Node 22.5 or newer, for the SQLite driver built into Node.
// It serves the pages, signs people in, stores what they make, and forwards API calls to Arcade
// and to AI providers with the keys added on the server, so no key ever reaches the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- .env loader (no dependency) ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const store = require('./lib/store');
const ai = require('./lib/ai');

const PORT = Number(process.env.PORT || 8787);
const BASE = (process.env.ARCADE_BASE_URL || 'https://platform.arcade.ai/v1').replace(/\/$/, '');
const HOST_KEY = (process.env.ARCADE_API_KEY || '').trim();
const CONTACT = (process.env.CONTACT_EMAIL || '').trim();
const USER_AGENT = `arcade-workbench/0.2${CONTACT ? ` (${CONTACT})` : ''}`;
// Whether signed-in people may use the keys in this server's .env when they have none of their own.
const SHARE_HOST_KEYS = process.env.SHARE_HOST_KEYS !== 'false';
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== 'false';
const DEV_LOGIN = !process.env.WORKBENCH_USERS;

// Only these Arcade endpoints can be called through the proxy.
const ALLOWED = new Set([
  'models/list',
  'categories/list', 'categories/get',
  'patterns/create', 'patterns/get', 'patterns/list',
  'patterns/refine/edit', 'patterns/refine/editRegion', 'patterns/refine/recolor',
  'patterns/refine/recolorClusters', 'patterns/refine/crop', 'patterns/refine/makeSeamless',
  'patterns/refine/extendPattern', 'patterns/refine/extendScene', 'patterns/refine/fixDeformity',
  'jobs/get',
  'products/create', 'products/get', 'products/list',
  'checkouts/create',
  'orders/get', 'orders/list',
]);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const GATED_PAGES = new Set(['index.html', 'bench.html']);

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const need = (cond, status, code, message) => { if (!cond) throw new HttpError(status, code, message); };

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'TOO_LARGE', 'Request body too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = (await readBody(req)) || '{}';
  try { return JSON.parse(raw); } catch (e) { throw new HttpError(400, 'BAD_BODY', `Request body must be JSON: ${e.message}`); }
}
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const sessionCookie = (token, maxAge) => `wb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const userFrom = (req) => { const t = cookies(req).wb_session; return t ? store.sessionUser(t) : null; };
const text = (v, max, fallback = '') => String(v ?? fallback).slice(0, max);

// ---------- keys: your own, or the host's ----------
function arcadeKeyFor(user) {
  const c = store.get("SELECT * FROM connections WHERE user_id = ? AND kind = 'arcade'", user.id);
  if (c && c.key_mode === 'own' && c.key_enc) return { key: store.unseal(c.key_enc), source: 'own' };
  if (HOST_KEY && SHARE_HOST_KEYS) return { key: HOST_KEY, source: 'host' };
  return { key: null, source: 'none' };
}
const hostKeyFor = (presetId) => { const env = ai.preset(presetId)?.env; return SHARE_HOST_KEYS && env ? (process.env[env] || '').trim() : ''; };
function aiKeyFor(c) {
  if (c.key_mode === 'host') {
    const k = hostKeyFor(c.preset);
    need(k, 400, 'NO_HOST_KEY', 'This server has no shared key for that provider. Add your own key to the connection.');
    return k;
  }
  if (c.key_enc) return store.unseal(c.key_enc);
  need(ai.preset(c.preset)?.noKey, 400, 'NO_KEY', 'Add an API key to this connection first.');
  return '';
}
const publicConnection = (c) => ({ id: c.id, kind: c.kind, preset: c.preset, name: c.name, baseUrl: c.base_url, model: c.model, keyMode: c.key_mode,
  hasKey: Boolean(c.key_enc), keyHint: c.key_hint, lastTest: c.last_test ? JSON.parse(c.last_test) : null, createdAt: c.created_at });
const ownConnection = (user, id) => { const c = store.get('SELECT * FROM connections WHERE id = ? AND user_id = ?', id, user.id); need(c, 404, 'NOT_FOUND', 'No such connection.'); return c; };
const hint = (key) => (key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : 'saved');

async function callArcade(key, endpoint, raw) {
  const started = Date.now();
  const upstream = await fetch(`${BASE}/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: raw });
  const body = await upstream.text();
  const ms = Date.now() - started;
  console.log(`${new Date().toISOString()}  ${upstream.status}  ${endpoint}  ${ms}ms`);
  let json;
  try { json = JSON.parse(body); } catch { json = { code: 'NON_JSON_RESPONSE', status: upstream.status, message: body.slice(0, 500) || '(empty response)' }; }
  return { status: upstream.status, json, ms, retryAfter: upstream.headers.get('retry-after') };
}
async function proxyArcade(req, res, user, endpoint) {
  if (!ALLOWED.has(endpoint)) return send(res, 404, { code: 'NOT_ALLOWED', message: `Endpoint "${endpoint}" is not on this server's allow-list.` });
  const { key } = arcadeKeyFor(user);
  if (!key) return send(res, 400, { code: 'NO_KEY', message: 'No Arcade key. Add your own under Models and keys, or ask the host to share one.' });
  const raw = (await readBody(req, 1024 * 1024)) || '{}';
  try { JSON.parse(raw); } catch (e) { return send(res, 400, { code: 'BAD_BODY', message: `Request body must be JSON: ${e.message}` }); }
  try {
    const r = await callArcade(key, endpoint, raw);
    const headers = { 'X-Upstream-Ms': String(r.ms) };
    if (r.retryAfter) headers['Retry-After'] = r.retryAfter;
    send(res, r.status, r.json, headers);
  } catch (e) {
    console.log(`${new Date().toISOString()}  ERR  ${endpoint}  ${e.message}`);
    send(res, 502, { code: 'UPSTREAM_UNREACHABLE', message: `Could not reach Arcade: ${e.cause?.code || e.message}` });
  }
}

// ---------- run history ----------
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
function runStats(rows) {
  const tally = (list) => { const ok = list.filter((r) => r.status === 'ok').length; return { total: list.length, ok, failed: list.length - ok, rate: list.length ? Math.round((ok / list.length) * 1000) / 10 : null }; };
  const group = (keyOf, labelOf) => {
    const map = new Map();
    for (const r of rows) { const k = keyOf(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); }
    return [...map].map(([key, list]) => ({ key, label: labelOf(list[0]), ...tally(list), medianMs: median(list.filter((r) => r.status === 'ok' && r.ms != null).map((r) => r.ms)) })).sort((a, b) => b.total - a.total);
  };
  const reasons = new Map();
  for (const r of rows) if (r.status !== 'ok') { const k = `${r.title}: ${r.error || 'Unknown error'}`; reasons.set(k, (reasons.get(k) || 0) + 1); }
  return { ...tally(rows), byStep: group((r) => r.node_type, (r) => ({ title: r.title, endpoint: r.endpoint })), byFlow: group((r) => r.flow_id || 'none', (r) => ({ title: r.flow_name || 'Unsaved flow' })),
    failures: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8) };
}

// ---------- routes ----------
const routes = [];
const on = (method, pattern, handler, open = false) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, open });
const failures = new Map(); // sign-in attempts per address

on('GET', '/api/health', ({ user }) => ({ ok: true, signup: ALLOW_SIGNUP, devLogin: DEV_LOGIN, hasKey: Boolean(user && arcadeKeyFor(user).key), baseUrl: BASE, userAgent: USER_AGENT }), true);
on('POST', '/api/login', ({ req, body, res }) => {
  const ip = req.socket.remoteAddress || 'local', f = failures.get(ip);
  need(!f || f.count < 10 || f.until < Date.now(), 429, 'SLOW_DOWN', 'Too many wrong passwords. Wait a few minutes.');
  const user = store.verifyUser(text(body.username, 64).trim().toLowerCase(), text(body.password, 200));
  if (!user) {
    failures.set(ip, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 5 * 60000 });
    throw new HttpError(401, 'BAD_LOGIN', 'That name and password do not match.');
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', sessionCookie(store.createSession(user.id), store.SESSION_DAYS * 86400));
  return { user: { username: user.username, role: user.role } };
}, true);
on('POST', '/api/signup', ({ body, res }) => {
  need(ALLOW_SIGNUP, 403, 'SIGNUP_OFF', 'New accounts are turned off on this server.');
  const username = text(body.username, 64).trim().toLowerCase(), password = text(body.password, 200);
  need(/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username), 422, 'BAD_NAME', 'Use 3 to 32 letters, numbers, dashes or underscores for the name.');
  need(password.length >= 8, 422, 'WEAK_PASSWORD', 'Use at least 8 characters for the password.');
  need(!store.get('SELECT 1 AS x FROM users WHERE username = ?', username), 409, 'NAME_TAKEN', 'That name is taken.');
  const user = store.createUser(username, password);
  res.setHeader('Set-Cookie', sessionCookie(store.createSession(user.id), store.SESSION_DAYS * 86400));
  return { user: { username: user.username, role: user.role } };
}, true);
on('POST', '/api/logout', ({ req, res }) => {
  const t = cookies(req).wb_session;
  if (t) store.endSession(t);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
}, true);
on('GET', '/api/me', ({ user }) => ({ user: { username: user.username, role: user.role }, arcade: { source: arcadeKeyFor(user).source, hostKeyAvailable: Boolean(HOST_KEY && SHARE_HOST_KEYS) }, arcadeBaseUrl: BASE }));

// flows
on('GET', '/api/flows', ({ user }) => ({ flows: store.all('SELECT id, name, updated_at AS updatedAt FROM flows WHERE user_id = ? ORDER BY updated_at DESC', user.id) }));
on('GET', '/api/flows/:id', ({ user, params }) => {
  const f = store.get('SELECT * FROM flows WHERE id = ? AND user_id = ?', params.id, user.id);
  need(f, 404, 'NOT_FOUND', 'No such flow.');
  return { id: f.id, name: f.name, updatedAt: f.updated_at, data: JSON.parse(f.data) };
});
on('PUT', '/api/flows/:id', ({ user, params, body }) => {
  need(/^[\w-]{6,80}$/.test(params.id), 422, 'BAD_ID', 'Bad flow id.');
  need(body.data && Array.isArray(body.data.nodes) && Array.isArray(body.data.edges), 422, 'BAD_FLOW', 'A flow needs steps and wires.');
  const other = store.get('SELECT user_id FROM flows WHERE id = ?', params.id);
  need(!other || other.user_id === user.id, 404, 'NOT_FOUND', 'No such flow.');
  const name = text(body.name, 80, 'Untitled flow') || 'Untitled flow';
  store.run('INSERT INTO flows (id, user_id, name, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at',
    params.id, user.id, name, JSON.stringify(body.data), store.now());
  return { id: params.id, name };
});
on('DELETE', '/api/flows/:id', ({ user, params }) => { store.run('DELETE FROM flows WHERE id = ? AND user_id = ?', params.id, user.id); return { ok: true }; });

// run history
on('POST', '/api/runs', ({ user, body }) => {
  need(body.nodeType && body.title && (body.status === 'ok' || body.status === 'error'), 422, 'BAD_RUN', 'A run needs a step type, a title and a status.');
  const id = store.id();
  store.run('INSERT INTO runs (id, user_id, flow_id, flow_name, batch_id, node_id, node_type, title, endpoint, world, status, http_status, error, ms, summary, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, user.id, text(body.flowId, 80) || null, text(body.flowName, 80) || null, text(body.batchId, 80) || null, text(body.nodeId, 80) || null, text(body.nodeType, 40), text(body.title, 80),
    text(body.endpoint, 80) || null, text(body.world, 20) || null, body.status, Number.isInteger(body.httpStatus) ? body.httpStatus : null, body.error ? text(body.error, 600) : null,
    Number.isFinite(body.ms) ? Math.round(body.ms) : null, body.summary ? text(body.summary, 300) : null, text(body.startedAt, 40) || store.now());
  return { id };
});
on('GET', '/api/runs', ({ user }) => {
  const rows = store.all('SELECT * FROM runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 5000', user.id);
  return { stats: runStats(rows), runs: rows.slice(0, 300).map((r) => ({ id: r.id, flowId: r.flow_id, flowName: r.flow_name, batchId: r.batch_id, nodeType: r.node_type, title: r.title, endpoint: r.endpoint,
    world: r.world, status: r.status, httpStatus: r.http_status, error: r.error, ms: r.ms, summary: r.summary, startedAt: r.started_at })) };
});
on('DELETE', '/api/runs', ({ user }) => { store.run('DELETE FROM runs WHERE user_id = ?', user.id); return { ok: true }; });

// connections: Arcade keys and AI models
on('GET', '/api/presets', () => ({ presets: ai.PRESETS.map((p) => ({ id: p.id, kind: p.kind, name: p.name, baseUrl: p.baseUrl, model: p.model, noKey: Boolean(p.noKey), keyUrl: p.keyUrl || null, hostKeyAvailable: Boolean(hostKeyFor(p.id)) })),
  arcadeHostKeyAvailable: Boolean(HOST_KEY && SHARE_HOST_KEYS) }));
on('GET', '/api/connections', ({ user }) => ({ connections: store.all('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at', user.id).map(publicConnection) }));
function connectionFields(body, existing) {
  const kind = existing ? existing.kind : body.kind;
  need(['arcade', 'openai', 'anthropic'].includes(kind), 422, 'BAD_KIND', 'Unknown connection type.');
  const keyMode = body.keyMode === 'host' ? 'host' : 'own';
  const baseUrl = kind === 'arcade' ? null : text(body.baseUrl ?? existing?.base_url, 300).trim();
  if (kind !== 'arcade') need(/^https?:\/\/[^\s]+$/.test(baseUrl), 422, 'BAD_URL', 'The base URL must start with http:// or https://.');
  return { kind, keyMode, baseUrl, preset: existing ? existing.preset : text(body.preset, 40) || null,
    name: text(body.name ?? existing?.name, 60).trim() || 'Untitled', model: kind === 'arcade' ? null : text(body.model ?? existing?.model, 120).trim(), apiKey: text(body.apiKey, 400).trim() };
}
on('POST', '/api/connections', ({ user, body }) => {
  const f = connectionFields(body, null);
  if (f.kind === 'arcade') need(!store.get("SELECT 1 AS x FROM connections WHERE user_id = ? AND kind = 'arcade'", user.id), 409, 'EXISTS', 'There is already an Arcade connection. Edit that one.');
  const id = store.id();
  store.run('INSERT INTO connections (id, user_id, kind, preset, name, base_url, model, key_mode, key_enc, key_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, user.id, f.kind, f.preset, f.name, f.baseUrl, f.model, f.keyMode, f.apiKey ? store.seal(f.apiKey) : null, f.apiKey ? hint(f.apiKey) : null, store.now());
  return publicConnection(ownConnection(user, id));
});
on('PUT', '/api/connections/:id', ({ user, params, body }) => {
  const c = ownConnection(user, params.id), f = connectionFields(body, c);
  store.run('UPDATE connections SET name = ?, base_url = ?, model = ?, key_mode = ? WHERE id = ?', f.name, f.baseUrl, f.model, f.keyMode, c.id);
  if (f.apiKey) store.run('UPDATE connections SET key_enc = ?, key_hint = ? WHERE id = ?', store.seal(f.apiKey), hint(f.apiKey), c.id);
  if (body.removeKey) store.run('UPDATE connections SET key_enc = NULL, key_hint = NULL WHERE id = ?', c.id);
  return publicConnection(ownConnection(user, c.id));
});
on('DELETE', '/api/connections/:id', ({ user, params }) => { store.run('DELETE FROM connections WHERE id = ? AND user_id = ?', params.id, user.id); return { ok: true }; });
// Test a connection with one small real request, and remember how it went.
on('POST', '/api/connections/:id/test', async ({ user, params, body }) => {
  const c = ownConnection(user, params.id), started = Date.now();
  let result;
  try {
    if (c.kind === 'arcade') {
      const { key, source } = arcadeKeyFor(user);
      need(key, 400, 'NO_KEY', 'No Arcade key to test. Add your own, or ask the host to share one.');
      const r = await callArcade(key, 'models/list', '{}');
      need(r.status === 200, r.status, r.json.code || 'ARCADE_ERROR', r.json.message || `Arcade answered ${r.status}.`);
      result = { ok: true, reply: `Arcade accepted the key (${source === 'own' ? 'your own' : "the host's"}). ${r.json.items?.length ?? 0} generation models available.` };
    } else {
      const reply = await ai.chat(c, aiKeyFor(c), { user: text(body.prompt, 2000).trim() || 'Reply with the single word: ready' });
      result = { ok: true, reply: reply.trim().slice(0, 1500) || '(the model returned no text)' };
    }
  } catch (e) { result = { ok: false, error: e.message, status: e.status || null }; }
  result.ms = Date.now() - started;
  result.at = store.now();
  store.run('UPDATE connections SET last_test = ? WHERE id = ?', JSON.stringify({ ...result, reply: result.reply ? result.reply.slice(0, 300) : undefined }), c.id);
  return result;
});
on('POST', '/api/connections/:id/models', async ({ user, params }) => {
  const c = ownConnection(user, params.id);
  need(c.kind !== 'arcade', 400, 'NOT_AI', 'Arcade has no model list here.');
  try { return { models: await ai.listModels(c, aiKeyFor(c)) }; }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(502, 'PROVIDER_ERROR', e.message); }
});

// prompts
on('GET', '/api/prompts', ({ user }) => ({ prompts: store.all('SELECT id, title, text, world, category, source, created_at AS createdAt FROM prompts WHERE user_id = ? ORDER BY created_at DESC', user.id) }));
on('POST', '/api/prompts', ({ user, body }) => {
  const body2 = text(body.text, 1000).trim();
  need(body2, 422, 'EMPTY', 'A prompt needs some text.');
  const id = store.id();
  store.run('INSERT INTO prompts (id, user_id, title, text, world, category, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, user.id, text(body.title, 80).trim() || body2.slice(0, 40),
    body2, ['print', 'jewelry'].includes(body.world) ? body.world : null, text(body.category, 80) || null, body.source === 'ai' ? 'ai' : 'manual', store.now());
  return { id };
});
on('PUT', '/api/prompts/:id', ({ user, params, body }) => {
  const body2 = text(body.text, 1000).trim();
  need(body2, 422, 'EMPTY', 'A prompt needs some text.');
  store.run('UPDATE prompts SET title = ?, text = ?, world = ?, category = ? WHERE id = ? AND user_id = ?', text(body.title, 80).trim() || body2.slice(0, 40), body2,
    ['print', 'jewelry'].includes(body.world) ? body.world : null, text(body.category, 80) || null, params.id, user.id);
  return { ok: true };
});
on('DELETE', '/api/prompts/:id', ({ user, params }) => { store.run('DELETE FROM prompts WHERE id = ? AND user_id = ?', params.id, user.id); return { ok: true }; });
// Ask a connected model for prompt ideas that follow Arcade's rules.
on('POST', '/api/ai/suggest', async ({ user, body }) => {
  const c = ownConnection(user, text(body.connectionId, 80));
  need(c.kind !== 'arcade', 400, 'NOT_AI', 'Choose an AI model connection.');
  const brief = ai.suggestBrief({ world: body.world, category: text(body.category, 80), materials: Array.isArray(body.materials) ? body.materials.slice(0, 20).map((m) => text(m, 60)) : [], idea: text(body.idea, 600), count: body.count });
  try { return { suggestions: ai.parseSuggestions(await ai.chat(c, aiKeyFor(c), brief)), model: c.model }; }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(e.status && e.status < 500 ? 400 : 502, 'PROVIDER_ERROR', e.message); }
});

// data: where it lives, taking it out, and pointing the server at another database
on('GET', '/api/data', ({ user }) => {
  const count = (table) => store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, user.id).n;
  return { engine: 'SQLite, built into Node', ...store.info(), isAdmin: user.role === 'admin', counts: { flows: count('flows'), runs: count('runs'), connections: count('connections'), prompts: count('prompts') },
    people: user.role === 'admin' ? store.get('SELECT COUNT(*) AS n FROM users').n : null };
});
on('GET', '/api/data/export', ({ user }) => ({ exportedAt: store.now(), user: user.username,
  flows: store.all('SELECT id, name, data, updated_at FROM flows WHERE user_id = ?', user.id).map((f) => ({ ...f, data: JSON.parse(f.data) })),
  runs: store.all('SELECT * FROM runs WHERE user_id = ? ORDER BY started_at', user.id),
  prompts: store.all('SELECT id, title, text, world, category, source, created_at FROM prompts WHERE user_id = ?', user.id),
  connections: store.all('SELECT * FROM connections WHERE user_id = ?', user.id).map(publicConnection) }));
on('POST', '/api/data/connect', ({ user, body }) => {
  need(user.role === 'admin', 403, 'ADMIN_ONLY', 'Only the admin can change the database.');
  try { store.connect(body.path); } catch (e) { throw new HttpError(422, 'BAD_DATABASE', `Could not open that database: ${e.message}`); }
  seedAccounts();
  return { ...store.info(), note: 'Connected. Everyone signs in again, because accounts live in the database.' };
});

function seedAccounts() { store.seedUsers(process.env.WORKBENCH_USERS || 'admin:admin'); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      // A page on another site must not be able to act as the signed-in person.
      const origin = req.headers.origin;
      if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-site requests are not allowed.');
      if (url.pathname.startsWith('/api/arcade/')) {
        if (req.method !== 'POST') throw new HttpError(405, 'METHOD', 'Use POST.');
        const user = userFrom(req);
        if (!user) throw new HttpError(401, 'SIGN_IN', 'Sign in first.');
        return await proxyArcade(req, res, user, url.pathname.slice('/api/arcade/'.length));
      }
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (!m) continue;
        const user = userFrom(req);
        if (!r.open && !user) throw new HttpError(401, 'SIGN_IN', 'Sign in first.');
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
        return send(res, 200, await r.handler({ req, res, user, params: m.groups || {}, query: url.searchParams, body }));
      }
      throw new HttpError(404, 'NOT_FOUND', 'No such endpoint.');
    }
    // Static files from ./public. The app pages need a session; the sign-in page and assets do not.
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(__dirname, 'public', rel));
    if (!file.startsWith(path.join(__dirname, 'public') + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
    if (GATED_PAGES.has(rel) && !userFrom(req)) { res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { code: e.code, message: e.message });
    console.log(`${new Date().toISOString()}  ERR  ${req.method} ${url.pathname}  ${e.stack || e.message}`);
    send(res, 500, { code: 'SERVER_ERROR', message: 'Something went wrong on the server. See its log.' });
  }
});

store.init();
seedAccounts();
// Bound to this machine only: the sign-in is a light one, and the server holds live keys.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Workbench running at http://localhost:${PORT}`);
  console.log(`Database: ${store.info().path}`);
  console.log(HOST_KEY ? `Arcade key loaded from the environment${SHARE_HOST_KEYS ? ', shared with everyone who signs in.' : ', not shared.'}` : 'No ARCADE_API_KEY in the environment: people add their own key after signing in.');
  if (DEV_LOGIN) console.log('Using the default sign-in (admin / admin). Set WORKBENCH_USERS before letting anyone else reach this server.');
});
