// The API watch: a background job that checks whether the APIs the workbench depends on have changed.
// It reads Arcade's published API description and each model maker's live model list, compares them
// with what it saw last time, and records the differences. It is a plain scheduled check: no AI model is involved.
const store = require('./store');
const ai = require('./ai');

const SPEC_URL = 'https://docs.arcade.ai/openapi.json';
const WATCHED_MAKERS = ['anthropic', 'openai', 'gemini'];
let running = null;
let timer = null;
let nextAt = null;

const previous = (id) => { const row = store.get('SELECT snapshot FROM watch WHERE id = ?', id); try { return row ? JSON.parse(row.snapshot) : null; } catch { return null; } };
function record(id, label, status, summary, changes, snapshot) {
  store.run('INSERT INTO watch (id, label, status, summary, changes, snapshot, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, status = excluded.status, summary = excluded.summary, changes = excluded.changes, snapshot = COALESCE(excluded.snapshot, watch.snapshot), checked_at = excluded.checked_at',
    id, label, status, summary, JSON.stringify(changes), snapshot == null ? null : JSON.stringify(snapshot), store.now());
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A request body reduced to a sorted list like "prompt*:string" or "tile.size*:integer", so two versions can be compared.
function fields(schema, prefix = '', depth = 0) {
  const out = [], required = new Set(schema?.required || []);
  for (const [name, prop] of Object.entries(schema?.properties || {})) {
    const type = prop.type || (prop.anyOf ? prop.anyOf.map((x) => x.type || x.const || 'object').join('|') : 'object');
    out.push(`${prefix}${name}${required.has(name) ? '*' : ''}:${type}${prop.enum ? `(${prop.enum.join(',')})` : ''}`);
    if (prop.type === 'object' && depth < 2) out.push(...fields(prop, `${prefix}${name}.`, depth + 1));
  }
  return out.sort();
}

// Arcade: compare today's API description with the last one, and with the endpoints the bench calls.
async function checkArcade({ usedEndpoints, userAgent }) {
  const id = 'arcade', label = 'Arcade API';
  try {
    const res = await fetch(SPEC_URL, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Arcade’s API description answered ${res.status}.`);
    const spec = await res.json();
    const now = {};
    for (const [path, item] of Object.entries(spec.paths || {})) now[path.replace(/^\//, '')] = fields(item.post?.requestBody?.content?.['application/json']?.schema || {});
    if (!Object.keys(now).length) throw new Error('Arcade’s API description lists no endpoints, so its shape has changed.');
    const prev = previous(id), changes = [];
    for (const e of usedEndpoints.filter((x) => !now[x])) changes.push({ level: 'action', text: `The bench calls ${e}, which Arcade no longer lists.` });
    if (prev) {
      for (const e of Object.keys(now).filter((x) => !prev[x])) changes.push({ level: 'info', text: `New endpoint: ${e}.` });
      for (const e of Object.keys(prev).filter((x) => !now[x] && !usedEndpoints.includes(x))) changes.push({ level: 'info', text: `Endpoint removed: ${e}.` });
      for (const e of Object.keys(now).filter((x) => prev[x])) {
        const added = now[e].filter((f) => !prev[e].includes(f)), gone = prev[e].filter((f) => !now[e].includes(f));
        if (!added.length && !gone.length) continue;
        const nowRequired = added.filter((f) => f.split(':')[0].endsWith('*'));
        changes.push({ level: usedEndpoints.includes(e) && (gone.length || nowRequired.length) ? 'action' : 'info',
          text: `${e} changed.${added.length ? ` New or changed: ${added.join(', ')}.` : ''}${gone.length ? ` No longer as before: ${gone.join(', ')}.` : ''}` });
      }
    }
    const unused = Object.keys(now).filter((x) => !usedEndpoints.includes(x));
    const status = changes.some((c) => c.level === 'action') ? 'action' : changes.length ? 'changed' : 'ok';
    const summary = `${prev ? (changes.length ? `${plural(changes.length, 'change')} since the last check.` : 'No change since the last check.') : `First check. ${plural(Object.keys(now).length, 'endpoint')} recorded.`}`
      + ` The bench uses ${usedEndpoints.filter((x) => now[x]).length} of ${Object.keys(now).length}${unused.length ? `; not used: ${unused.join(', ')}` : ''}.`;
    record(id, label, status, summary, changes, now);
  } catch (e) { record(id, label, 'error', `Could not check: ${e.cause?.code || e.message}`, [], null); }
}

// Arcade's documentation: compare the list of pages, and what each says it covers, with the last check.
async function checkDocs({ userAgent }) {
  const id = 'arcade-docs', label = 'Arcade documentation';
  try {
    const res = await fetch('https://docs.arcade.ai/llms.txt', { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Arcade’s documentation index answered ${res.status}.`);
    const now = {};
    for (const m of (await res.text()).matchAll(/^- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/gm)) now[m[2]] = `${m[1]} | ${(m[3] || '').trim()}`;
    if (!Object.keys(now).length) throw new Error('Arcade’s documentation index lists no pages, so its shape has changed.');
    const prev = previous(id), changes = [];
    const name = (v) => v.split(' | ')[0];
    if (prev) {
      for (const u of Object.keys(now).filter((x) => !prev[x])) changes.push({ level: 'info', text: `New page: ${name(now[u])} (${u}).` });
      for (const u of Object.keys(prev).filter((x) => !now[x])) changes.push({ level: 'info', text: `Page removed: ${name(prev[u])}.` });
      for (const u of Object.keys(now).filter((x) => prev[x] && prev[x] !== now[x])) changes.push({ level: 'info', text: `Page description changed: ${name(now[u])} (${u}).` });
    }
    record(id, label, changes.length ? 'changed' : 'ok', `${prev ? (changes.length ? `${plural(changes.length, 'change')} since the last check.` : 'No change since the last check.') : 'First check.'} ${plural(Object.keys(now).length, 'page')} listed.`, changes, now);
  } catch (e) { record(id, label, 'error', `Could not check: ${e.cause?.code || e.message}`, [], null); }
}

// A model maker: compare the text models a key can use with the last list, and keep the ready-made model valid.
async function checkMaker(presetId, key) {
  const p = ai.preset(presetId), id = `models-${presetId}`, label = `${p.short} models`;
  if (!key) return record(id, label, 'skipped', `No company key for ${p.short}, so its models are checked when someone connects their own key or presses Check now.`, [], null);
  try {
    const conn = { kind: p.kind, preset: p.id, base_url: p.baseUrl, model: p.model };
    const ids = (await ai.listModels(conn, key)).filter(ai.isTextModel);
    if (!ids.length) throw new Error(`${p.short} returned no text models, so its model list has changed shape.`);
    const prev = previous(id), changes = [];
    let best = '';
    for (const re of ai.PREFER[presetId] || []) { best = ids.filter((m) => re.test(m)).sort().pop() || ''; if (best) break; }
    if (p.model && !ids.includes(p.model)) changes.push({ level: 'action', text: `The ready-made model ${p.model} is not available on this key. ${best || 'No replacement'} is used instead.` });
    if (prev) {
      const added = ids.filter((m) => !prev.includes(m)), gone = prev.filter((m) => !ids.includes(m));
      if (added.length) changes.push({ level: 'info', text: `New: ${added.slice(0, 8).join(', ')}${added.length > 8 ? `, and ${added.length - 8} more` : ''}.` });
      if (gone.length) changes.push({ level: 'info', text: `Gone: ${gone.slice(0, 8).join(', ')}${gone.length > 8 ? `, and ${gone.length - 8} more` : ''}.` });
      // Connections on the company key that still point at a model which is gone are moved to the best one left.
      if (best) {
        const stale = store.all("SELECT id, model FROM connections WHERE preset = ? AND key_mode = 'host' AND model != ''", presetId).filter((c) => !ids.includes(c.model));
        for (const c of stale) store.run('UPDATE connections SET model = ? WHERE id = ?', best, c.id);
        if (stale.length) changes.push({ level: 'action', text: `${plural(stale.length, 'connection')} moved to ${best}, because the model in use is gone.` });
      }
    }
    const status = changes.some((c) => c.level === 'action') ? 'action' : changes.length ? 'changed' : 'ok';
    record(id, label, status, `${prev ? (changes.length ? `${plural(changes.length, 'change')} since the last check.` : 'No change since the last check.') : 'First check.'} ${plural(ids.length, 'text model')} available${best ? `; best fit ${best}` : ''}.`, changes, ids);
  } catch (e) { record(id, label, 'error', `Could not check: ${e.message}`, [], null); }
}

// One pass over everything. keyFor(presetId) gives the key to use for a maker, or '' for none.
function runAll({ usedEndpoints, userAgent, keyFor }) {
  if (running) return running;
  running = (async () => {
    await checkArcade({ usedEndpoints, userAgent });
    await checkDocs({ userAgent });
    for (const m of WATCHED_MAKERS) await checkMaker(m, keyFor(m));
  })().finally(() => { running = null; });
  return running;
}
function start(opts, hours) {
  if (!(hours > 0)) return;
  const tick = () => { nextAt = new Date(Date.now() + hours * 3600000).toISOString(); runAll(opts).catch(() => {}); };
  setTimeout(tick, 4000).unref();
  timer = setInterval(tick, hours * 3600000);
  timer.unref();
}
const report = () => ({ nextAt, checks: store.all('SELECT id, label, status, summary, changes, checked_at AS checkedAt FROM watch ORDER BY id').map((r) => ({ ...r, changes: JSON.parse(r.changes || '[]') })) });

module.exports = { start, runAll, report, WATCHED_MAKERS };
