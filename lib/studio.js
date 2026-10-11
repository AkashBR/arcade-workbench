// Studio: put an Arcade piece on a model, in several poses.
//
// What it needs (inputs):
//   1. A piece: an Arcade product. Its render is the reference image, so the piece stays the one Arcade will make.
//   2. An image model: the person's OpenAI connection (only the key is theirs to add).
//   3. A shot plan: who wears it, which poses, the look, and any direction in their own words.
// What it gives back (outputs):
//   A shoot: the original render plus one image per pose. Each image keeps the exact prompt that made it,
//   can be approved, redone or edited with an instruction, and is served from /api/studio/file/:id.
//
// This file is self-contained on purpose: the page (public/studio.*) and the bench step both call the routes below.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'studio');
// OpenAI's GPT Image 2.5 is the only image model Studio uses unless OPENAI_IMAGE_MODEL names another.
const IMAGE_MODEL = (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst').trim();

// ---------- the choices a person gets ----------
// Poses depend on what the piece is. Each has the sentence that goes into the prompt.
const POSES = {
  ring: [
    { id: 'hand-close', label: 'Hand close-up', needs: 'model', text: 'A close-up of a relaxed hand wearing the ring on the ring finger, fingers slightly apart, the ring facing the camera.' },
    { id: 'hand-face', label: 'Hand by the face', needs: 'model', text: 'A portrait from the shoulders up, one hand resting lightly against the jaw so the ring is in clear view.' },
    { id: 'holding', label: 'Holding a cup', needs: 'model', text: 'A lifestyle shot of two hands wrapped around a ceramic cup, the ring clearly visible on the nearer hand.' },
    { id: 'stacked', label: 'Hands together', needs: 'model', text: 'Two hands gently clasped in front of a soft knit sweater, the ring catching the light.' },
    { id: 'flat', label: 'Studio flat lay', needs: 'none', text: 'A product photograph of the ring alone, lying on a smooth surface, shot from slightly above with a soft shadow.' },
    { id: 'macro', label: 'Detail macro', needs: 'none', text: 'A macro photograph of the ring alone, three-quarter view, showing the surface texture and edges in sharp detail.' },
    { id: 'packshot', label: 'Catalog packshot', needs: 'none', text: 'A catalog packshot of the ring alone: centered, straight on, filling most of the frame, evenly lit, with a soft contact shadow under it.' },
    { id: 'ugc', label: 'Customer photo', needs: 'model', text: 'A casual photo of the kind a happy customer posts: taken on a phone in an ordinary home, natural window light, slightly imperfect framing, the ring being worn and clearly visible.' },
    { id: 'seasonal', label: 'Gift moment', needs: 'none', text: 'A gifting still life: the ring resting in an open gift box on soft tissue paper, a ribbon and a few seasonal props nearby, warm and inviting.' },
  ],
  earrings: [
    { id: 'profile', label: 'Profile close-up', needs: 'model', text: 'A side profile close-up of the ear and jawline, hair tucked behind the ear, the earring in sharp focus.' },
    { id: 'three-quarter', label: 'Three-quarter portrait', needs: 'model', text: 'A three-quarter portrait from the shoulders up, head turned slightly so one earring faces the camera.' },
    { id: 'front', label: 'Front portrait', needs: 'model', text: 'A front-facing portrait from the collarbone up, hair pulled back, both earrings visible.' },
    { id: 'candid', label: 'Candid, looking away', needs: 'model', text: 'A candid portrait looking away from the camera, one hand brushing hair back to show the earring.' },
    { id: 'flat', label: 'Studio flat lay', needs: 'none', text: 'A product photograph of the pair of earrings alone, laid side by side on a smooth surface, shot from above with soft shadows.' },
    { id: 'macro', label: 'Detail macro', needs: 'none', text: 'A macro photograph of one earring alone, showing its surface texture and edges in sharp detail.' },
    { id: 'packshot', label: 'Catalog packshot', needs: 'none', text: 'A catalog packshot of the earrings alone: centered, straight on, filling most of the frame, evenly lit, with a soft contact shadow under it.' },
    { id: 'ugc', label: 'Customer photo', needs: 'model', text: 'A casual photo of the kind a happy customer posts: taken on a phone in an ordinary home, natural window light, slightly imperfect framing, the earrings being worn and clearly visible.' },
    { id: 'seasonal', label: 'Gift moment', needs: 'none', text: 'A gifting still life: the earrings resting in an open gift box on soft tissue paper, a ribbon and a few seasonal props nearby, warm and inviting.' },
  ],
  necklace: [
    { id: 'collarbone', label: 'Collarbone close-up', needs: 'model', text: 'A close-up of the neck and collarbone, the necklace resting naturally against the skin, the pendant centered.' },
    { id: 'front', label: 'Front portrait', needs: 'model', text: 'A front-facing portrait from the chest up in a simple open-neck top, the necklace clearly visible.' },
    { id: 'three-quarter', label: 'Three-quarter portrait', needs: 'model', text: 'A three-quarter portrait from the chest up, shoulders turned, the necklace catching the light.' },
    { id: 'touch', label: 'Touching the pendant', needs: 'model', text: 'A portrait from the chest up, fingertips lightly touching the pendant.' },
    { id: 'flat', label: 'Studio flat lay', needs: 'none', text: 'A product photograph of the necklace alone, the chain laid in a soft curve on a smooth surface, shot from above.' },
    { id: 'macro', label: 'Detail macro', needs: 'none', text: 'A macro photograph of the pendant alone, showing its surface texture and edges in sharp detail.' },
    { id: 'packshot', label: 'Catalog packshot', needs: 'none', text: 'A catalog packshot of the necklace alone: centered, straight on, filling most of the frame, evenly lit, with a soft contact shadow under it.' },
    { id: 'ugc', label: 'Customer photo', needs: 'model', text: 'A casual photo of the kind a happy customer posts: taken on a phone in an ordinary home, natural window light, slightly imperfect framing, the necklace being worn and clearly visible.' },
    { id: 'seasonal', label: 'Gift moment', needs: 'none', text: 'A gifting still life: the necklace resting in an open gift box on soft tissue paper, a ribbon and a few seasonal props nearby, warm and inviting.' },
  ],
  print: [
    { id: 'in-room', label: 'In a room', needs: 'none', text: 'An interior photograph of the product in use in a calm, well-lit room, styled simply, the pattern clearly readable.' },
    { id: 'in-hands', label: 'Held in hands', needs: 'model', text: 'Two hands holding the product, the pattern facing the camera and clearly readable.' },
    { id: 'styled', label: 'Styled scene', needs: 'none', text: 'A styled still life with the product as the subject and two or three plain props around it.' },
    { id: 'flat', label: 'Studio flat lay', needs: 'none', text: 'A product photograph of the product alone, laid flat and shot from directly above, the whole pattern visible.' },
    { id: 'macro', label: 'Detail macro', needs: 'none', text: 'A close-up of the product showing the weave of the material and the pattern in sharp detail.' },
    { id: 'packshot', label: 'Catalog packshot', needs: 'none', text: 'A catalog packshot of the product alone: centered, straight on, filling most of the frame, evenly lit, with a soft contact shadow under it.' },
    { id: 'ugc', label: 'Customer photo', needs: 'none', text: 'A casual photo of the kind a happy customer posts: taken on a phone in an ordinary home, natural window light, slightly imperfect framing, the product in use and clearly visible.' },
    { id: 'seasonal', label: 'Gift moment', needs: 'none', text: 'A gifting still life: the product resting in an open gift box on soft tissue paper, a ribbon and a few seasonal props nearby, warm and inviting.' },
  ],
};
const WEARERS = [
  { id: 'woman', label: 'Woman', text: 'a woman' },
  { id: 'man', label: 'Man', text: 'a man' },
  { id: 'person', label: 'Any model', text: 'a person' },
  { id: 'none', label: 'No model', text: '' },
];
const SKIN = [
  { id: 'any', label: 'Any', swatch: null, text: '' },
  { id: 'light', label: 'Light', swatch: '#F1D7C2', text: 'light skin' },
  { id: 'medium', label: 'Medium', swatch: '#C99B76', text: 'medium skin' },
  { id: 'tan', label: 'Tan', swatch: '#A6744E', text: 'tan skin' },
  { id: 'deep', label: 'Deep', swatch: '#5E3B27', text: 'deep brown skin' },
];
const AGES = [{ id: 'any', label: 'Any', text: '' }, { id: '20s', label: '20s', text: 'in their twenties' }, { id: '30s', label: '30s', text: 'in their thirties' }, { id: '40s', label: '40s and up', text: 'in their forties or fifties' }];
const BACKGROUNDS = [
  { id: 'studio', label: 'Soft studio', swatch: '#EDEAE4', text: 'Seamless warm off-white studio background.' },
  { id: 'white', label: 'Pure white', swatch: '#FFFFFF', text: 'Clean pure white background.' },
  { id: 'stone', label: 'Stone', swatch: '#B9B2A5', text: 'Honed grey stone surface and background.' },
  { id: 'daylight', label: 'Outdoor daylight', swatch: '#CFE0EA', text: 'Outdoors in soft natural daylight with a softly blurred background.' },
  { id: 'dark', label: 'Dark and moody', swatch: '#2A2724', text: 'Dark charcoal background with a single soft light.' },
];
const LIGHTS = [
  { id: 'soft', label: 'Soft daylight', text: 'Soft, even window light.' },
  { id: 'studio', label: 'Studio', text: 'Controlled studio lighting with gentle highlights on the metal.' },
  { id: 'golden', label: 'Golden hour', text: 'Warm low golden-hour light.' },
];
// A look is a ready-made mood: one click sets the background and the light, and adds a line of styling.
const LOOKS = [
  { id: 'none', label: 'As chosen below', swatch: null, text: '' },
  { id: 'minimal', label: 'Minimal white', swatch: '#FFFFFF', background: 'white', light: 'studio', text: 'Minimal styling: nothing in the frame that is not needed, generous empty space, crisp and clean.' },
  { id: 'golden', label: 'Golden hour', swatch: '#F0B56A', background: 'daylight', light: 'golden', text: 'A warm, glowing mood with long soft shadows and a gentle haze.' },
  { id: 'moody', label: 'Moody dark', swatch: '#2A2724', background: 'dark', light: 'studio', text: 'A dramatic, low-key mood: deep shadows, one pool of light, rich contrast.' },
  { id: 'earth', label: 'Earth tones', swatch: '#B08A62', background: 'stone', light: 'soft', text: 'Styled in earth tones: linen, clay, sand and unpolished wood, calm and natural.' },
  { id: 'pastel', label: 'Soft pastel', swatch: '#F3D7E0', background: 'studio', light: 'soft', text: 'A soft pastel palette of blush, powder blue and cream, light and airy.' },
  { id: 'botanical', label: 'Botanical', swatch: '#7FA07A', background: 'daylight', light: 'soft', text: 'Fresh green leaves and a few small flowers around the edge of the frame, out of focus.' },
  { id: 'stone', label: 'Stone and concrete', swatch: '#9B978F', background: 'stone', light: 'studio', text: 'Raw mineral surfaces: honed stone and smooth concrete, architectural and cool.' },
];
const SHAPES = [{ id: 'square', label: 'Square', size: '1024x1024' }, { id: 'portrait', label: 'Portrait', size: '1024x1536' }, { id: 'landscape', label: 'Landscape', size: '1536x1024' }];
const DEFAULTS = { wearer: 'woman', skin: 'any', age: 'any', background: 'studio', light: 'soft', shape: 'square', look: 'none', consistent: true };

const pieceType = (title) => (/earring/i.test(title) ? 'earrings' : /necklace|pendant|chain/i.test(title) ? 'necklace' : /ring|band/i.test(title) ? 'ring' : 'print');
const byId = (list, id, fallback) => list.find((x) => x.id === id) || list.find((x) => x.id === fallback) || list[0];

// The prompt for one shot, in three parts. The first reference image is always the Arcade render.
//   scene:     what the picture shows. Ready-made from the piece and the choices, or the person's own words.
//   guard:     always added, whoever wrote the scene, so the piece stays the one Arcade will make.
//   direction: the person's extra art direction, if any.
function promptParts(shoot, plan, pose, hasFace) {
  const type = shoot.type, noun = type === 'print' ? 'product' : type === 'earrings' ? 'earrings' : type;
  const wearer = byId(WEARERS, plan.wearer, DEFAULTS.wearer), skin = byId(SKIN, plan.skin, 'any'), age = byId(AGES, plan.age, 'any');
  const withModel = pose.needs === 'model' && wearer.id !== 'none';
  const who = withModel ? [wearer.text, age.text, skin.text && `with ${skin.text}`].filter(Boolean).join(' ') : '';
  const scene = [
    'A photorealistic product photograph for an online shop.',
    pose.text,
    withModel ? `The model is ${who}, with natural skin texture and natural, correctly formed hands.` : 'No person in the frame.',
    byId(BACKGROUNDS, plan.background, DEFAULTS.background).text,
    byId(LIGHTS, plan.light, DEFAULTS.light).text,
    byId(LOOKS, plan.look, 'none').text,
  ];
  const guard = [
    `The ${noun} is the exact one in the first reference image${shoot.material ? ` (${shoot.material})` : ''}. Keep its shape, proportions, color, finish and every detail the same. Do not add, remove or restyle any part of it, and do not add stones, engraving or text.`,
    hasFace && withModel ? 'The second reference image shows the model from an earlier shot. Use the same person: same face, hair and skin tone.' : '',
    `Sharp focus on the ${noun}. No text, logos, watermarks or borders.`,
  ];
  const direction = String(plan.direction || '').trim() ? `Art direction from the client: ${String(plan.direction).trim().slice(0, 600)}` : '';
  return { scene: scene.filter(Boolean).join(' '), guard: guard.filter(Boolean).join(' '), direction };
}
function buildPrompt(shoot, plan, pose, hasFace, ownScene = '') {
  const p = promptParts(shoot, plan, pose, hasFace);
  return [String(ownScene || '').trim() || p.scene, p.guard, p.direction].filter(Boolean).join(' ');
}

// ---------- the image model ----------
// OpenAI's image edit endpoint: reference images in, one image out.
async function generate(conn, key, { prompt, images, size }) {
  // STUDIO_IMAGE_BASE_URL sends image requests somewhere else (a proxy, or a stand-in when testing).
  const base = String(process.env.STUDIO_IMAGE_BASE_URL || conn.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const send = async (extra) => {
    const form = new FormData();
    form.append('model', IMAGE_MODEL);
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('n', '1');
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    for (const img of images) form.append('image[]', new Blob([img.bytes], { type: img.type }), img.name);
    let res;
    try { res = await fetch(`${base}/images/edits`, { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {}, body: form, signal: AbortSignal.timeout(240000) }); }
    catch (e) { const err = new Error(`Could not reach the image model: ${e.cause?.code || e.name || e.message}`); err.status = 502; throw err; }
    const body = await res.json().catch(() => null);
    if (!res.ok) { const err = new Error(`${res.status} from the image model: ${body?.error?.message || 'no details'}`); err.status = res.status; err.param = body?.error?.param; throw err; }
    const b64 = body?.data?.[0]?.b64_json;
    if (!b64) { const err = new Error('The image model returned no image.'); err.status = 502; throw err; }
    return Buffer.from(b64, 'base64');
  };
  // input_fidelity belongs to the first GPT Image models only (1 and 1.5); later ones keep the reference faithful by
  // themselves and reject the field. If a model still refuses it, try once without.
  if (!/^gpt-image-1(\.5)?(-|$)/.test(IMAGE_MODEL)) return send({});
  try { return await send({ input_fidelity: 'high' }); }
  catch (e) { if (e.status === 400 && /input_fidelity|unknown parameter|unrecognized/i.test(e.message + (e.param || ''))) return send({}); throw e; }
}

// ---------- storage ----------
function register({ on, store, need, text, HttpError, arcadeKeyFor, callArcade, aiKeyFor, hostKeyFor }) {
  const ensure = () => {
    store.run(`CREATE TABLE IF NOT EXISTS shoots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, material TEXT, price TEXT, source_type TEXT, created_at TEXT NOT NULL)`);
    store.run(`CREATE TABLE IF NOT EXISTS shots (id TEXT PRIMARY KEY, shoot_id TEXT NOT NULL, user_id TEXT NOT NULL, pose TEXT NOT NULL, label TEXT NOT NULL, prompt TEXT NOT NULL, plan TEXT NOT NULL, parent_id TEXT, note TEXT, approved INTEGER, ms INTEGER, created_at TEXT NOT NULL)`);
  };
  const dirOf = (shoot) => path.join(DIR, shoot.user_id, shoot.id);
  const sourceFile = (shoot) => path.join(dirOf(shoot), `source.${shoot.source_type === 'image/jpeg' ? 'jpg' : shoot.source_type === 'image/webp' ? 'webp' : 'png'}`);
  const shotFile = (shoot, shotId) => path.join(dirOf(shoot), `${shotId}.png`);
  const ownShoot = (user, id) => { ensure(); const s = store.get('SELECT * FROM shoots WHERE id = ? AND user_id = ?', id, user.id); need(s, 404, 'NOT_FOUND', 'No such shoot.'); return s; };
  const ownShot = (user, id) => { ensure(); const s = store.get('SELECT * FROM shots WHERE id = ? AND user_id = ?', id, user.id); need(s, 404, 'NOT_FOUND', 'No such shot.'); return s; };
  const publicShot = (s) => ({ id: s.id, shootId: s.shoot_id, pose: s.pose, label: s.label, prompt: s.prompt, plan: JSON.parse(s.plan), parentId: s.parent_id, note: s.note, approved: s.approved == null ? null : Boolean(s.approved), ms: s.ms, createdAt: s.created_at, url: `/api/studio/file/${s.id}` });
  const publicShoot = (s, shots) => ({ id: s.id, productId: s.product_id, title: s.title, type: s.type, material: s.material, price: s.price, createdAt: s.created_at, sourceUrl: `/api/studio/source/${s.id}`, poses: POSES[s.type], ...(shots ? { shots: shots.map(publicShot) } : {}) });
  // Which image model this person can use: their own OpenAI connection, or the company key if one is shared.
  function imageAccess(user) {
    const c = store.get("SELECT * FROM connections WHERE user_id = ? AND preset = 'openai' ORDER BY created_at LIMIT 1", user.id);
    if (c) { try { return { conn: c, key: aiKeyFor(c), source: c.key_mode === 'host' ? 'company' : 'own' }; } catch { /* no usable key on it */ } }
    const host = hostKeyFor('openai');
    return host ? { conn: { base_url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' }, key: host, source: 'company' } : null;
  }
  async function makeShot(user, shoot, { pose, plan, prompt, images, parentId = null, note = null }) {
    const access = imageAccess(user);
    need(access, 400, 'NO_IMAGE_MODEL', 'Add an OpenAI key first. Model shots are made with OpenAI’s image model.');
    const started = Date.now();
    let bytes;
    try { bytes = await generate(access.conn, access.key, { prompt, images, size: byId(SHAPES, plan.shape, DEFAULTS.shape).size }); }
    catch (e) { throw new HttpError(e.status && e.status < 500 ? (e.status === 401 ? 400 : e.status) : 502, 'IMAGE_MODEL_ERROR', e.message); }
    const id = store.id();
    fs.mkdirSync(dirOf(shoot), { recursive: true });
    fs.writeFileSync(shotFile(shoot, id), bytes);
    store.run('INSERT INTO shots (id, shoot_id, user_id, pose, label, prompt, plan, parent_id, note, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, shoot.id, user.id, pose.id, pose.label, prompt, JSON.stringify(plan), parentId, note, Date.now() - started, store.now());
    return publicShot(ownShot(user, id));
  }
  const sourceImage = (shoot) => ({ bytes: fs.readFileSync(sourceFile(shoot)), type: shoot.source_type || 'image/png', name: path.basename(sourceFile(shoot)) });
  const shotImage = (shoot, id) => ({ bytes: fs.readFileSync(shotFile(shoot, id)), type: 'image/png', name: `${id}.png` });
  function sendFile(res, file, type) {
    need(fs.existsSync(file), 404, 'NOT_FOUND', 'That image is gone.');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  }

  // ---------- routes ----------
  on('GET', '/api/studio/options', ({ user }) => {
    const access = imageAccess(user);
    return { poses: POSES, wearers: WEARERS, skin: SKIN, ages: AGES, backgrounds: BACKGROUNDS, lights: LIGHTS, shapes: SHAPES, looks: LOOKS, defaults: DEFAULTS,
      image: { ready: Boolean(access), source: access?.source || null, model: IMAGE_MODEL, companyKeyAvailable: Boolean(hostKeyFor('openai')) } };
  });
  on('GET', '/api/studio/shoots', ({ user }) => {
    ensure();
    return { shoots: store.all('SELECT * FROM shoots WHERE user_id = ? ORDER BY created_at DESC LIMIT 60', user.id).map((s) => {
      const n = store.get('SELECT COUNT(*) AS n FROM shots WHERE shoot_id = ?', s.id).n;
      const cover = store.get('SELECT id FROM shots WHERE shoot_id = ? ORDER BY approved DESC, created_at DESC LIMIT 1', s.id);
      return { ...publicShoot(s), count: n, coverUrl: cover ? `/api/studio/file/${cover.id}` : `/api/studio/source/${s.id}` };
    }) };
  });
  // Start a shoot from an Arcade product. The render is copied here, because Arcade's image links expire.
  on('POST', '/api/studio/shoots', async ({ user, body }) => {
    ensure();
    const productId = text(body.productId, 80).trim();
    need(productId, 422, 'NO_PRODUCT', 'Choose a product first.');
    const existing = store.get('SELECT * FROM shoots WHERE user_id = ? AND product_id = ? ORDER BY created_at DESC LIMIT 1', user.id, productId);
    if (existing && !body.fresh && fs.existsSync(sourceFile(existing))) return publicShoot(existing, store.all('SELECT * FROM shots WHERE shoot_id = ? ORDER BY created_at', existing.id));
    const { key } = arcadeKeyFor(user);
    need(key, 400, 'NO_KEY', 'No Arcade key. Add one to read the product.');
    // Arcade limits how often it can be asked. When it says "too many requests", wait as long as it asks and try again, twice at most.
    let r = await callArcade(key, 'products/get', JSON.stringify({ productId }));
    for (let tries = 0; r.status === 429 && tries < 2; tries++) {
      await new Promise((done) => setTimeout(done, Math.min(15, Number(r.retryAfter) || 10) * 1000));
      r = await callArcade(key, 'products/get', JSON.stringify({ productId }));
    }
    need(r.status !== 429, 429, 'ARCADE_BUSY', 'Arcade is asking for fewer requests right now, so the piece could not be read. This is not the image model. Wait a few seconds and run it again.');
    need(r.status === 200, r.status === 404 ? 404 : 502, 'ARCADE_ERROR', r.json.message || `Arcade answered ${r.status} for that product.`);
    const p = r.json, url = p.images?.[0]?.url || p.imageUrl;
    need(url, 502, 'NO_IMAGE', 'Arcade has no picture for that product yet.');
    const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
    need(img.ok, 502, 'NO_IMAGE', `Could not download the product picture (${img.status}).`);
    const type = (img.headers.get('content-type') || 'image/png').split(';')[0];
    const shoot = { id: store.id(), user_id: user.id, product_id: productId, title: p.title || 'Untitled piece', type: pieceType(p.title || ''), material: p.selectionLabel || null,
      price: p.unitPrice ? `${p.unitPrice.currency === 'USD' ? '$' : ''}${p.unitPrice.amount}${p.unitPrice.currency === 'USD' ? '' : ' ' + p.unitPrice.currency}` : null, source_type: /^image\/(png|jpeg|webp)$/.test(type) ? type : 'image/png' };
    fs.mkdirSync(dirOf(shoot), { recursive: true });
    fs.writeFileSync(sourceFile(shoot), Buffer.from(await img.arrayBuffer()));
    store.run('INSERT INTO shoots (id, user_id, product_id, title, type, material, price, source_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', shoot.id, user.id, productId, shoot.title, shoot.type, shoot.material, shoot.price, shoot.source_type, store.now());
    return publicShoot(ownShoot(user, shoot.id), []);
  });
  on('GET', '/api/studio/shoots/:id', ({ user, params }) => { const s = ownShoot(user, params.id); return publicShoot(s, store.all('SELECT * FROM shots WHERE shoot_id = ? ORDER BY created_at', s.id)); });
  on('DELETE', '/api/studio/shoots/:id', ({ user, params }) => {
    const s = ownShoot(user, params.id);
    store.run('DELETE FROM shots WHERE shoot_id = ?', s.id);
    store.run('DELETE FROM shoots WHERE id = ?', s.id);
    fs.rmSync(dirOf(s), { recursive: true, force: true });
    return { ok: true };
  });
  const planFrom = (body) => ({ ...DEFAULTS, ...Object.fromEntries(['wearer', 'skin', 'age', 'background', 'light', 'shape', 'look'].map((k) => [k, text(body[k], 20) || DEFAULTS[k]])), consistent: body.consistent !== false, direction: text(body.direction, 600) });
  // The prompt a shot would use, without making the shot: shown on the page so it can be read and rewritten first.
  on('POST', '/api/studio/shoots/:id/prompt', ({ user, params, body }) => {
    const shoot = ownShoot(user, params.id);
    const pose = POSES[shoot.type].find((p) => p.id === body.pose);
    need(pose, 422, 'BAD_POSE', 'That pose does not fit this kind of piece.');
    const plan = planFrom(body);
    return { pose: pose.id, ...promptParts(shoot, plan, pose, false), prompt: buildPrompt(shoot, plan, pose, false, text(body.prompt, 2400)) };
  });
  // One pose, one image. The page and the bench step call this once per pose, one at a time.
  on('POST', '/api/studio/shoots/:id/shots', async ({ user, params, body }) => {
    const shoot = ownShoot(user, params.id);
    const pose = POSES[shoot.type].find((p) => p.id === body.pose);
    need(pose, 422, 'BAD_POSE', 'That pose does not fit this kind of piece.');
    const plan = planFrom(body);
    const images = [sourceImage(shoot)];
    // Same model across poses: hand the image model an earlier shot of the same person, if there is one.
    const withModel = pose.needs === 'model' && plan.wearer !== 'none';
    const face = withModel && plan.consistent ? store.all('SELECT * FROM shots WHERE shoot_id = ? ORDER BY created_at', shoot.id).find((s) => { const pl = JSON.parse(s.plan); return POSES[shoot.type].find((p) => p.id === s.pose)?.needs === 'model' && pl.wearer === plan.wearer && pl.skin === plan.skin && pl.age === plan.age && fs.existsSync(shotFile(shoot, s.id)); }) : null;
    if (face) images.push(shotImage(shoot, face.id));
    // body.prompt is the person's own scene text for this pose, if they wrote one. The guard lines are added to it either way.
    return makeShot(user, shoot, { pose, plan, prompt: buildPrompt(shoot, plan, pose, Boolean(face), text(body.prompt, 2400)), images });
  });
  // Edit an output: the shot and the original render go back in, with the instruction.
  on('POST', '/api/studio/shots/:id/edit', async ({ user, params, body }) => {
    const shot = ownShot(user, params.id), shoot = ownShoot(user, shot.shoot_id);
    const instruction = text(body.instruction, 600).trim();
    need(instruction, 422, 'EMPTY', 'Say what to change.');
    const noun = shoot.type === 'print' ? 'product' : shoot.type;
    const prompt = `Edit the first image: ${instruction} Keep everything else the same. The ${noun} must stay exactly as it is in the second reference image: same shape, proportions, color, finish and details. No text, logos or watermarks.`;
    const pose = POSES[shoot.type].find((p) => p.id === shot.pose) || { id: shot.pose, label: shot.label };
    return makeShot(user, shoot, { pose, plan: JSON.parse(shot.plan), prompt, images: [shotImage(shoot, shot.id), sourceImage(shoot)], parentId: shot.id, note: instruction });
  });
  on('PUT', '/api/studio/shots/:id', ({ user, params, body }) => {
    const shot = ownShot(user, params.id);
    store.run('UPDATE shots SET approved = ? WHERE id = ?', body.approved == null ? null : body.approved ? 1 : 0, shot.id);
    return publicShot(ownShot(user, shot.id));
  });
  on('DELETE', '/api/studio/shots/:id', ({ user, params }) => {
    const shot = ownShot(user, params.id), shoot = ownShoot(user, shot.shoot_id);
    store.run('DELETE FROM shots WHERE id = ?', shot.id);
    fs.rmSync(shotFile(shoot, shot.id), { force: true });
    return { ok: true };
  });
  on('GET', '/api/studio/file/:id', ({ user, params, res }) => { const shot = ownShot(user, params.id); sendFile(res, shotFile(ownShoot(user, shot.shoot_id), shot.id), 'image/png'); });
  on('GET', '/api/studio/source/:id', ({ user, params, res }) => { const shoot = ownShoot(user, params.id); sendFile(res, sourceFile(shoot), shoot.source_type || 'image/png'); });
}

module.exports = { register, POSES, buildPrompt, pieceType };
