// Storefronts: list a product from the bench in a shop the person already runs (WooCommerce or Shopify),
// and turn that shop's paid orders into what Arcade needs to make and ship them.
// The store's keys are kept like every other key here: encrypted, per person, never sent back to the browser.
//
// The one hard limit: Arcade takes orders only through its own checkout page. So for each store order this
// creates an Arcade checkout link; a person still opens it, types the buyer's address and pays.
const fs = require('fs');
const path = require('path');

const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const STUDIO_DIR = path.join(__dirname, '..', 'data', 'studio'); // where lib/studio.js keeps model shots

const PLATFORMS = [
  { id: 'woocommerce', name: 'WooCommerce', urlHint: 'https://yourshop.com',
    fields: [
      { key: 'key', label: 'Consumer key', hint: 'ck_…' },
      { key: 'secret', label: 'Consumer secret', hint: 'cs_…' },
      { key: 'wpUser', label: 'WordPress username (only needed to send model shots)', hint: 'optional', optional: true, plain: true },
      { key: 'wpPass', label: 'WordPress application password (only needed to send model shots)', hint: 'optional', optional: true },
    ],
    where: 'In WordPress: WooCommerce, Settings, Advanced, REST API, Add key, with Read/Write. For model shots, also Users, Profile, Application Passwords.' },
  { id: 'shopify', name: 'Shopify', urlHint: 'your-store.myshopify.com',
    // Two ways in. An app from Shopify's Dev Dashboard has a client ID and secret, which are exchanged for a token
    // that lasts a day and is renewed by itself. An older custom app has one long-lived Admin API access token.
    fields: [
      { key: 'clientId', label: 'Client ID', hint: 'from the Dev Dashboard', optional: true, plain: true },
      { key: 'clientSecret', label: 'Client secret', hint: 'shpss_…', optional: true },
      { key: 'key', label: 'Or, instead of those two: an Admin API access token', hint: 'shpat_…', optional: true },
    ],
    where: 'Client ID and secret: dev.shopify.com, your app, Settings. This works when the app and the store are in the same Shopify organization and the app is installed on the store. Access token: Shopify admin, Settings, Apps and sales channels, Develop apps. Either way the app needs write_products and read_products, and read_orders to read orders.' },
];
const platform = (id) => PLATFORMS.find((p) => p.id === id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function register({ on, store, need, text, HttpError, arcadeKeyFor, callArcade }) {
  // The tables are made on demand, so they also appear in a database connected later.
  const ready = () => {
    store.run('CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, secret_enc TEXT NOT NULL, hint TEXT, last_test TEXT, created_at TEXT NOT NULL)');
    store.run('CREATE TABLE IF NOT EXISTS store_listings (store_id TEXT NOT NULL, arcade_product_id TEXT NOT NULL, user_id TEXT NOT NULL, store_product_id TEXT NOT NULL, url TEXT, admin_url TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (store_id, arcade_product_id))');
    store.run('CREATE TABLE IF NOT EXISTS store_orders (store_id TEXT NOT NULL, order_id TEXT NOT NULL, user_id TEXT NOT NULL, checkout_id TEXT NOT NULL, checkout_url TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (store_id, order_id))');
  };
  const pub = (s) => ({ id: s.id, platform: s.platform, platformName: platform(s.platform)?.name || s.platform, name: s.name, url: s.url, hint: s.hint, lastTest: s.last_test ? JSON.parse(s.last_test) : null });
  const mine = (user, id) => { ready(); const s = store.get('SELECT * FROM stores WHERE id = ? AND user_id = ?', id, user.id); need(s, 404, 'NOT_FOUND', 'No such store.'); return s; };
  const credsOf = (s) => JSON.parse(store.unseal(s.secret_enc));

  function cleanUrl(p, raw) {
    let u = text(raw, 300).trim().replace(/\/+$/, '');
    need(u, 422, 'NO_URL', 'Enter the store’s address.');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    let parsed;
    try { parsed = new URL(u); } catch { throw new HttpError(422, 'BAD_URL', 'That store address is not a web address.'); }
    if (p.id === 'shopify') {
      need(/\.myshopify\.com$/i.test(parsed.hostname), 422, 'BAD_URL', 'Use the store’s myshopify.com address, for example your-store.myshopify.com.');
      return `https://${parsed.hostname}`;
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  }
  async function call(url, init) {
    let res;
    try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) }); }
    catch (e) { throw new HttpError(502, 'STORE_UNREACHABLE', `Could not reach ${new URL(url).host}: ${e.cause?.code || e.name || e.message}`); }
    const raw = await res.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: res.status, body, raw };
  }
  // Arcade limits how often it can be called; a "too many requests" answer is waited out and tried again.
  async function arcade(key, endpoint, payload) {
    for (let attempt = 0; ; attempt++) {
      const r = await callArcade(key, endpoint, JSON.stringify(payload));
      if (r.status !== 429 || attempt >= 2) return r;
      await sleep(Math.min(Number(r.retryAfter) || 5, 12) * 1000);
    }
  }
  const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const wooAuth = (c) => ({ Authorization: basic(c.key, c.secret), 'Content-Type': 'application/json' });
  async function woo(s, c, pathAndQuery, init = {}) {
    const r = await call(`${s.url}/wp-json/wc/v3/${pathAndQuery}`, { ...init, headers: wooAuth(c) });
    if (r.status === 401 || r.status === 403) throw new HttpError(400, 'STORE_REFUSED', `WooCommerce did not accept the keys (${r.status}). ${r.body?.message || ''}`.trim());
    if (r.status === 404 && !init.method) throw new HttpError(400, 'STORE_ERROR', 'No WooCommerce REST API at that address. Check the address, and that pretty permalinks are on.');
    if (r.status < 200 || r.status > 299 || r.body == null) throw new HttpError(502, 'STORE_ERROR', `WooCommerce answered ${r.status}: ${(r.body?.message || r.raw).slice(0, 240)}`);
    return r.body;
  }
  // A client ID and secret are exchanged for an access token (Shopify's client credentials grant). The token lasts
  // a day, so it is kept in memory until shortly before it runs out and fetched again when needed.
  const shopifyTokens = new Map();
  async function shopifyToken(s, c, fresh = false) {
    if (c.key) return c.key;
    const id = `${s.url}|${c.clientId}`, held = shopifyTokens.get(id);
    if (!fresh && held && held.until > Date.now()) return held.token;
    const r = await call(`${s.url}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }).toString() });
    if (r.status !== 200 || !r.body?.access_token) {
      const why = r.body?.error === 'shop_not_permitted'
        ? 'Shopify only allows a client ID and secret for a store in the same organization as the app, with the app installed on it. For any other store, use an Admin API access token.'
        : r.body?.error_description || r.body?.error || (r.status === 404 ? 'There is no Shopify store at that address.' : r.raw.slice(0, 160));
      throw new HttpError(400, 'STORE_REFUSED', `Shopify did not accept the client ID and secret (${r.status}). ${why}`);
    }
    shopifyTokens.set(id, { token: r.body.access_token, until: Date.now() + Math.max(60, (Number(r.body.expires_in) || 86400) - 300) * 1000 });
    return r.body.access_token;
  }
  async function shopify(s, c, query, variables) {
    const send = async (token) => call(`${s.url}/admin/api/${SHOPIFY_VERSION}/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    let r = await send(await shopifyToken(s, c));
    if (r.status === 401 && !c.key) r = await send(await shopifyToken(s, c, true)); // the day-long token ran out early
    if (r.status === 401 || r.status === 403) throw new HttpError(400, 'STORE_REFUSED', `Shopify did not accept the access token (${r.status}).`);
    if (r.status !== 200 || !r.body) throw new HttpError(502, 'STORE_ERROR', `Shopify answered ${r.status}: ${r.raw.slice(0, 200)}`);
    if (r.body.errors) throw new HttpError(400, 'STORE_ERROR', `Shopify said: ${[].concat(r.body.errors).map((e) => e.message || e).join('; ')}`);
    return r.body.data;
  }
  // One small read, to prove the address and keys work.
  async function testStore(s, c) {
    if (s.platform === 'woocommerce') { await woo(s, c, 'products?per_page=1'); return 'WooCommerce accepted the keys.'; }
    const d = await shopify(s, c, 'query WorkbenchShop { shop { name myshopifyDomain currencyCode } }');
    return `Connected to ${d.shop.name} (${d.shop.currencyCode}).`;
  }

  on('GET', '/api/stores', ({ user }) => { ready(); return { platforms: PLATFORMS, stores: store.all('SELECT * FROM stores WHERE user_id = ? ORDER BY created_at', user.id).map(pub) }; });
  on('POST', '/api/stores', async ({ user, body }) => {
    ready();
    const p = platform(text(body.platform, 20));
    need(p, 422, 'BAD_PLATFORM', 'Choose WooCommerce or Shopify.');
    const creds = {};
    for (const f of p.fields) { creds[f.key] = text(body[f.key], 400).trim(); need(f.optional || creds[f.key], 422, 'NO_KEY', `Paste the ${f.label.toLowerCase()}.`); }
    if (p.id === 'shopify') need(creds.key || (creds.clientId && creds.clientSecret), 422, 'NO_KEY', 'Paste the client ID and the client secret, or an Admin API access token.');
    const s = { id: store.id(), platform: p.id, url: cleanUrl(p, body.url) };
    const note = await testStore(s, creds); // a store that fails this is not saved
    s.name = text(body.name, 60).trim() || new URL(s.url).hostname;
    const last = { ok: true, reply: note, at: store.now() };
    store.run('INSERT INTO stores (id, user_id, platform, name, url, secret_enc, hint, last_test, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', s.id, user.id, s.platform, s.name, s.url,
      store.seal(JSON.stringify(creds)), ((k) => (k.length > 8 ? `${k.slice(0, 5)}…${k.slice(-4)}` : 'saved'))(creds.key || creds.clientId || ''), JSON.stringify(last), store.now());
    return { store: pub(mine(user, s.id)), test: last };
  });
  on('DELETE', '/api/stores/:id', ({ user, params }) => { ready(); store.run('DELETE FROM stores WHERE id = ? AND user_id = ?', params.id, user.id); return { ok: true }; });

  // ---------- model shots ----------
  // A store cannot fetch a model shot by link (the files sit behind sign-in), so the picture itself is sent.
  function shotFiles(user, ids) {
    const out = [];
    for (const id of ids) {
      let row = null;
      try { row = store.get('SELECT id, shoot_id, label FROM shots WHERE id = ? AND user_id = ?', id, user.id); } catch { /* Studio has not been used on this database */ }
      const file = row && path.join(STUDIO_DIR, user.id, row.shoot_id, `${row.id}.png`);
      if (file && fs.existsSync(file)) out.push({ id: row.id, label: row.label || 'Model shot', file });
    }
    return out;
  }
  async function wooMedia(s, c, shot, title) {
    const r = await call(`${s.url}/wp-json/wp/v2/media`, { method: 'POST', body: fs.readFileSync(shot.file),
      headers: { Authorization: basic(c.wpUser, c.wpPass), 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="model-shot-${shot.id.slice(0, 8)}.png"` } });
    if (r.status !== 201 || !r.body?.id) throw new HttpError(400, 'STORE_ERROR', `WordPress did not take the model shot (${r.status}): ${(r.body?.message || r.raw).slice(0, 200)}`);
    return { id: r.body.id, alt: `${title}: ${shot.label} (AI-styled)` };
  }
  async function shopifyStaged(s, c, shot) {
    const size = fs.statSync(shot.file).size, filename = `model-shot-${shot.id.slice(0, 8)}.png`;
    const d = await shopify(s, c, 'mutation WorkbenchStage($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }',
      { input: [{ filename, mimeType: 'image/png', httpMethod: 'POST', resource: 'IMAGE', fileSize: String(size) }] });
    const errs = d.stagedUploadsCreate.userErrors;
    if (errs.length) throw new HttpError(400, 'STORE_ERROR', `Shopify did not accept the model shot: ${errs.map((e) => e.message).join('; ')}`);
    const target = d.stagedUploadsCreate.stagedTargets[0];
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append('file', new Blob([fs.readFileSync(shot.file)], { type: 'image/png' }), filename);
    const up = await fetch(target.url, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    if (up.status < 200 || up.status > 299) throw new HttpError(502, 'STORE_ERROR', `Shopify’s upload address answered ${up.status} for a model shot.`);
    return target.resourceUrl;
  }

  // ---------- collections ----------
  // Shopify collections and WooCommerce product categories. A Shopify "smart" collection fills itself by rules,
  // so products cannot be added to it by hand.
  async function loadCollections(s, c) {
    if (s.platform === 'woocommerce') return (await woo(s, c, 'products/categories?per_page=100')).map((x) => ({ id: String(x.id), title: x.name, canAdd: true }));
    const d = await shopify(s, c, 'query WorkbenchCollections { collections(first: 100, sortKey: TITLE) { nodes { id title ruleSet { appliedDisjunctively } } } }');
    return d.collections.nodes.map((x) => ({ id: x.id, title: x.title, canAdd: !x.ruleSet }));
  }
  // Which collection fits a product, judged by name: Arcade's category first, then the kind of product.
  const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, ''));
  function suggestCollection(list, category, world) {
    const cat = words(category), usable = list.filter((x) => x.canAdd);
    const same = usable.find((x) => cat.length && words(x.title).join(' ') === cat.join(' '));
    if (same) return { ids: [same.id], why: `“${same.title}” was picked because it has the same name as Arcade’s category.` };
    const within = usable.find((x) => { const t = words(x.title); return t.length && cat.length && t.every((w) => cat.includes(w)); });
    if (within) return { ids: [within.id], why: `“${within.title}” was picked because Arcade’s category is “${category}”.` };
    const kind = world === 'jewelry' ? usable.find((x) => /jewel/i.test(x.title)) : null;
    if (kind) return { ids: [kind.id], why: `“${kind.title}” was picked because this is a piece of jewelry.` };
    return { ids: [], why: category ? `Nothing in the store matches “${category}”. Choose one, or make a new one.` : 'Choose a collection, or make a new one.' };
  }
  on('GET', '/api/stores/:id/collections', async ({ user, params, query }) => {
    const s = mine(user, params.id), list = await loadCollections(s, credsOf(s));
    const pick = suggestCollection(list, text(query.get('category'), 80), text(query.get('world'), 20));
    return { collections: list, suggested: pick.ids, why: pick.why, word: s.platform === 'woocommerce' ? 'category' : 'collection' };
  });
  // What the store has for a product listed from here: read back, not remembered.
  on('GET', '/api/stores/:id/listing', async ({ user, params, query }) => {
    const s = mine(user, params.id), c = credsOf(s);
    const kept = store.get('SELECT * FROM store_listings WHERE store_id = ? AND arcade_product_id = ?', s.id, text(query.get('productId'), 80));
    if (!kept) return { listed: false };
    if (s.platform === 'woocommerce') {
      const p = await woo(s, c, `products/${kept.store_product_id}`).catch(() => null);
      if (!p) return { listed: false, gone: true };
      return { listed: true, status: p.status === 'publish' ? 'Live' : 'Draft', price: p.regular_price || null, collections: (p.categories || []).map((x) => x.name), url: p.permalink || kept.url, adminUrl: kept.admin_url, readAt: store.now() };
    }
    const d = await shopify(s, c, 'query WorkbenchListing($id: ID!) { product(id: $id) { id title status onlineStorePreviewUrl variants(first: 1) { nodes { price } } collections(first: 20) { nodes { id title } } } }', { id: kept.store_product_id });
    if (!d.product) return { listed: false, gone: true };
    return { listed: true, status: d.product.status === 'ACTIVE' ? 'Live' : 'Draft', price: d.product.variants.nodes[0]?.price || null, collections: d.product.collections.nodes.map((x) => x.title), url: d.product.onlineStorePreviewUrl || kept.url, adminUrl: kept.admin_url, readAt: store.now() };
  });

  // ---------- listing ----------
  // The product is read from Arcade again here, so its picture link is fresh (the store downloads the picture
  // when the listing is created) and the details cannot be altered on the way.
  on('POST', '/api/stores/:id/publish', async ({ user, params, body }) => {
    const s = mine(user, params.id), c = credsOf(s);
    const { key } = arcadeKeyFor(user);
    need(key, 400, 'NO_KEY', 'No Arcade key, so the product cannot be read.');
    const got = await arcade(key, 'products/get', { productId: text(body.productId, 80), quantity: 1 });
    need(got.status === 200, got.status === 429 ? 429 : 400, 'ARCADE_ERROR', got.status === 429 ? 'Arcade is asking for fewer requests right now. Try again in a few seconds.' : `Arcade could not return that product (${got.status}).`);
    const prod = got.json, cost = prod.unitPrice ? Number(prod.unitPrice.amount) : null;
    const price = Number(body.price) > 0 ? Number(body.price) : cost;
    need(price > 0, 422, 'NO_PRICE', 'Set a price for the store listing.');
    const title = text(body.title, 120).trim() || prod.title;
    const images = (prod.images || []).map((i) => i.url).filter(Boolean).slice(0, 6);
    const shots = shotFiles(user, Array.isArray(body.shotIds) ? body.shotIds.slice(0, 6).map((x) => text(x, 80)) : []);
    const asked = Array.isArray(body.shotIds) ? body.shotIds.length : 0;
    const live = Boolean(body.live);
    const about = [prod.selectionLabel, prod.maker?.name ? `Made to order by ${prod.maker.name}.` : 'Made to order.', prod.description || '',
      shots.length ? 'The first picture shows the piece as made. Pictures of it being worn are AI-styled.' : ''].filter(Boolean).join('\n\n');
    const notes = [];
    let listed, shotsSent = 0, updated = false;
    // A product already listed in this store from here is updated, never listed twice.
    const kept = store.get('SELECT * FROM store_listings WHERE store_id = ? AND arcade_product_id = ?', s.id, prod.productId);
    const wanted = Array.isArray(body.collections) ? body.collections.slice(0, 12).map((x) => text(x, 120)).filter(Boolean) : [];
    const newName = text(body.newCollection, 80).trim();
    if (s.platform === 'woocommerce') {
      // Arcade's own picture always goes first.
      const pictures = images.map((src) => ({ src }));
      if (shots.length && !(c.wpUser && c.wpPass)) notes.push('Model shots were not sent. WooCommerce keys cannot upload pictures: connect the store again with a WordPress username and application password.');
      else for (const shot of shots) { const m = await wooMedia(s, c, shot, title); pictures.push({ id: m.id, alt: m.alt }); shotsSent++; }
      if (newName) wanted.push(String((await woo(s, c, 'products/categories', { method: 'POST', body: JSON.stringify({ name: newName }) })).id));
      const payload = { name: title, regular_price: price.toFixed(2), description: about.replace(/\n/g, '<br>'), short_description: prod.selectionLabel || '', status: live ? 'publish' : 'draft',
        images: pictures, categories: wanted.map((id) => ({ id: Number(id) })), meta_data: [{ key: '_arcade_product_id', value: prod.productId }] };
      let made = null;
      if (kept) {
        // Gone from the store since? Then it is listed afresh.
        made = await woo(s, c, `products/${kept.store_product_id}`, { method: 'PUT', body: JSON.stringify(payload) }).catch((e) => (/answered 404/.test(e.message) ? null : Promise.reject(e)));
        updated = Boolean(made);
      }
      if (!made) made = await woo(s, c, 'products', { method: 'POST', body: JSON.stringify({ ...payload, type: 'simple' }) });
      listed = { storeProductId: String(made.id), url: made.permalink || null, adminUrl: `${s.url}/wp-admin/post.php?post=${made.id}&action=edit` };
    } else {
      const fields = { title, descriptionHtml: about.replace(/\n/g, '<br>'), status: live ? 'ACTIVE' : 'DRAFT' };
      let made = null;
      if (kept) {
        const u = await shopify(s, c, 'mutation WorkbenchUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status variants(first: 1) { nodes { id } } onlineStorePreviewUrl } userErrors { field message } } }',
          { product: { id: kept.store_product_id, ...fields } });
        if (u.productUpdate.product && !u.productUpdate.userErrors.length) { made = u.productUpdate.product; updated = true; notes.push('The pictures on an existing Shopify listing are left as they are.'); }
      }
      if (!made) {
        const media = images.map((src) => ({ originalSource: src, mediaContentType: 'IMAGE', alt: `${title}, as made` }));
        for (const shot of shots) { media.push({ originalSource: await shopifyStaged(s, c, shot), mediaContentType: 'IMAGE', alt: `${title}: ${shot.label} (AI-styled)` }); shotsSent++; }
        const d = await shopify(s, c, 'mutation WorkbenchCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) { productCreate(product: $product, media: $media) { product { id handle title status onlineStorePreviewUrl variants(first: 1) { nodes { id } } } userErrors { field message } } }',
          { product: { ...fields, vendor: prod.maker?.name || 'Arcade', tags: ['arcade', `arcade-${prod.productId}`] }, media });
        const errs = d.productCreate.userErrors;
        if (errs.length) throw new HttpError(400, 'STORE_ERROR', `Shopify did not create the product: ${errs.map((e) => e.message).join('; ')}`);
        made = d.productCreate.product;
      }
      if (newName) {
        const nc = await shopify(s, c, 'mutation WorkbenchNewCollection($input: CollectionInput!) { collectionCreate(input: $input) { collection { id title } userErrors { field message } } }', { input: { title: newName } });
        if (nc.collectionCreate.userErrors.length) notes.push(`The collection \u201c${newName}\u201d was not made: ${nc.collectionCreate.userErrors.map((e) => e.message).join('; ')}`);
        else wanted.push(nc.collectionCreate.collection.id);
      }
      for (const id of wanted) {
        const ca = await shopify(s, c, 'mutation WorkbenchCollect($id: ID!, $productIds: [ID!]!) { collectionAddProducts(id: $id, productIds: $productIds) { collection { id title } userErrors { field message } } }', { id, productIds: [made.id] });
        // Already being in the collection is not a problem worth reporting.
        const real = ca.collectionAddProducts.userErrors.filter((e) => !/already/i.test(e.message));
        if (real.length) notes.push(`Not added to a collection: ${real.map((e) => e.message).join('; ')}`);
      }
      const variantId = made.variants.nodes[0]?.id;
      if (variantId) {
        const pd = await shopify(s, c, 'mutation WorkbenchPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price } userErrors { field message } } }',
          { productId: made.id, variants: [{ id: variantId, price: price.toFixed(2) }] });
        if (pd.productVariantsBulkUpdate.userErrors.length) notes.push(`The product was created, but its price was not set: ${pd.productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; ')}`);
      }
      listed = { storeProductId: made.id, url: made.onlineStorePreviewUrl || null, adminUrl: `${s.url}/admin/products/${made.id.split('/').pop()}` };
    }
    store.run('INSERT INTO store_listings (store_id, arcade_product_id, user_id, store_product_id, url, admin_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(store_id, arcade_product_id) DO UPDATE SET store_product_id = excluded.store_product_id, url = excluded.url, admin_url = excluded.admin_url, updated_at = excluded.updated_at',
      s.id, prod.productId, user.id, listed.storeProductId, listed.url, listed.adminUrl, store.now());
    if (asked > shots.length) notes.push(`${asked - shots.length} model shot${asked - shots.length === 1 ? ' was' : 's were'} not found on this server and left out.`);
    return { ...listed, platform: s.platform, platformName: platform(s.platform).name, storeName: s.name, title, price: price.toFixed(2), currency: prod.unitPrice?.currency || 'USD',
      arcadePrice: cost == null ? null : cost.toFixed(2), live, pictures: images.length, shots: shotsSent, updated, collections: wanted.length, note: notes.join(' ') || null, productId: prod.productId };
  });

  // ---------- orders ----------
  // Recent paid orders in the store, each line matched back to the Arcade product it was listed from.
  async function loadOrders(s, c) {
    if (s.platform === 'woocommerce') {
      const raw = await woo(s, c, 'orders?status=processing&per_page=20&orderby=date&order=desc');
      const arcadeIdOf = new Map();
      const lookup = async (productId) => {
        if (!arcadeIdOf.has(productId)) {
          const p = await woo(s, c, `products/${productId}`).catch(() => null);
          arcadeIdOf.set(productId, p?.meta_data?.find((m) => m.key === '_arcade_product_id')?.value || null);
        }
        return arcadeIdOf.get(productId);
      };
      const out = [];
      for (const o of raw) {
        const a = o.shipping?.address_1 ? o.shipping : o.billing || {};
        const lines = [];
        for (const li of o.line_items || []) lines.push({ title: li.name, quantity: li.quantity, arcadeProductId: li.product_id ? await lookup(li.product_id) : null });
        out.push({ id: String(o.id), number: `#${o.number || o.id}`, placedAt: o.date_created_gmt ? o.date_created_gmt + 'Z' : o.date_created, total: o.total ? `${o.total} ${o.currency || ''}`.trim() : '',
          buyer: { name: [a.first_name, a.last_name].filter(Boolean).join(' '), lines: [a.address_1, a.address_2, [a.city, a.state, a.postcode].filter(Boolean).join(', '), a.country].filter(Boolean), email: o.billing?.email || '', phone: o.billing?.phone || a.phone || '' }, lines });
      }
      return out;
    }
    const d = await shopify(s, c, 'query WorkbenchOrders { orders(first: 20, sortKey: CREATED_AT, reverse: true, query: "financial_status:paid fulfillment_status:unfulfilled") { nodes { id name createdAt email totalPriceSet { shopMoney { amount currencyCode } } shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 phone } lineItems(first: 20) { nodes { title quantity product { id tags } } } } } }');
    return d.orders.nodes.map((o) => {
      const a = o.shippingAddress || {};
      return { id: o.id, number: o.name, placedAt: o.createdAt, total: o.totalPriceSet ? `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}` : '',
        buyer: { name: a.name || '', lines: [a.address1, a.address2, [a.city, a.provinceCode, a.zip].filter(Boolean).join(', '), a.countryCodeV2].filter(Boolean), email: o.email || '', phone: a.phone || '' },
        lines: o.lineItems.nodes.map((li) => ({ title: li.title, quantity: li.quantity, arcadeProductId: (li.product?.tags || []).map((t) => /^arcade-(.+)$/.exec(t)?.[1]).find(Boolean) || null })) };
    });
  }
  const withCheckouts = (s, orders) => orders.map((o) => {
    const row = store.get('SELECT checkout_id, checkout_url, created_at FROM store_orders WHERE store_id = ? AND order_id = ?', s.id, o.id);
    return { ...o, checkout: row ? { checkoutId: row.checkout_id, checkoutUrl: row.checkout_url, createdAt: row.created_at } : null };
  });
  on('GET', '/api/stores/:id/orders', async ({ user, params }) => {
    const s = mine(user, params.id);
    return { storeName: s.name, platformName: platform(s.platform).name, readAt: store.now(), orders: withCheckouts(s, await loadOrders(s, credsOf(s))) };
  });
  // The Arcade checkout for one store order. The order is read from the store again, so the lines are the store's
  // own; one order gets one checkout, however many times this is asked for.
  on('POST', '/api/stores/:id/checkout', async ({ user, params, body }) => {
    const s = mine(user, params.id), orderId = text(body.orderId, 120);
    const kept = store.get('SELECT checkout_id, checkout_url, created_at FROM store_orders WHERE store_id = ? AND order_id = ?', s.id, orderId);
    if (kept) return { checkoutId: kept.checkout_id, checkoutUrl: kept.checkout_url, createdAt: kept.created_at, already: true };
    const order = (await loadOrders(s, credsOf(s))).find((o) => o.id === orderId);
    need(order, 404, 'NO_ORDER', 'That order is no longer among the store’s paid, unshipped orders.');
    const lines = order.lines.filter((l) => l.arcadeProductId).map((l) => ({ productId: l.arcadeProductId, quantity: Math.min(1000, Math.max(1, Number(l.quantity) || 1)) }));
    need(lines.length, 422, 'NO_ARCADE_LINES', 'Nothing in that order was listed from Arcade.');
    const { key } = arcadeKeyFor(user);
    need(key, 400, 'NO_KEY', 'No Arcade key, so the checkout cannot be created.');
    // The same requestId for the same order, so a retry can never make a second checkout.
    const r = await arcade(key, 'checkouts/create', { requestId: `store-${s.id.slice(0, 8)}-${orderId}`.replace(/[^\w-]/g, '-').slice(0, 128), lines, dropShip: true });
    need(r.status === 200, r.status === 429 ? 429 : 400, 'ARCADE_ERROR', r.status === 429 ? 'Arcade is asking for fewer requests right now. Try again in a few seconds.' : `Arcade did not create the checkout (${r.status}): ${r.json.message || ''}`);
    store.run('INSERT INTO store_orders (store_id, order_id, user_id, checkout_id, checkout_url, created_at) VALUES (?, ?, ?, ?, ?, ?)', s.id, orderId, user.id, r.json.checkoutId, r.json.checkoutUrl, store.now());
    return { checkoutId: r.json.checkoutId, checkoutUrl: r.json.checkoutUrl, createdAt: store.now(), already: false };
  });
}

module.exports = { register, PLATFORMS };
