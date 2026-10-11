// Two bench steps for a shop the person already runs (WooCommerce or Shopify):
// "List in a store" puts a product made here into the shop, and "Store orders" turns the shop's paid orders
// into Arcade checkout links. Loaded after nodes.js and before workbench.js.
(function () {
  'use strict';
  const A = window.ArcadeNodes, App = window.App;
  if (!A) return;
  const esc = (App && App.esc) || ((s) => String(s ?? ''));
  const usd = (v, cur) => (v == null ? '' : (cur && cur !== 'USD' ? '' : '$') + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur && cur !== 'USD' ? ' ' + cur : ''));
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  A.ICONS.store = '<path d="M4 9.500l1.500-5h13l1.500 5"/><path d="M4 9.500a2.700 2.700 0 0 0 5.300 0 2.700 2.700 0 0 0 5.400 0 2.700 2.700 0 0 0 5.300 0"/><path d="M5.500 12.500V20h13v-7.500M10 20v-4.500h4V20"/>';
  A.ICONS.orders = '<path d="M6 4h12v16l-3-2-3 2-3-2-3 2z"/><path d="M9 9h6M9 13h6"/>';

  A.NODES.storeListing = {
    type: 'storeListing', title: 'List in a store', group: 'Sell', endpoint: 'your store · create product', worlds: ['print', 'jewelry'], cost: 'publish',
    blurb: 'Adds this product to your WooCommerce or Shopify store, at the price you choose.',
    rules: [
      'The listing takes Arcade’s title, description and picture, and the price you set. Your price can be higher than Arcade’s: the difference is your margin.',
      'Connect Model shots to send those pictures too. Arcade’s own picture always goes first, and the others are described as AI-styled.',
      'For WooCommerce, model shots need a WordPress username and application password on the store connection. Shopify needs nothing extra.',
      'It is created as a draft unless you tick the box, so nothing shows to shoppers until you say so.',
      'Run it again and the same listing is updated: price, description, status and collections. It is never listed twice in one store.',
      'The collection that matches Arcade\u2019s category is picked for you. Shopify collections that fill themselves by rules cannot be chosen.',
      'Orders placed in your store are not sent to Arcade automatically. The Store orders step turns each one into an Arcade checkout link.',
      'It never runs as part of Run flow. You confirm each listing.',
    ],
    inputs: [{ key: 'product', type: 'product', label: 'Product' }, { key: 'shots', type: 'shots', label: 'Shots', optional: true }],
    outputs: [],
    fields: [
      { key: 'storeId', kind: 'store', label: 'Store' },
      { key: 'collections', kind: 'collections', label: 'Collections' },
      { key: 'price', kind: 'number', label: 'Your price in the store', min: 0 },
      { key: 'live', kind: 'check', label: 'Show it to shoppers straight away (otherwise it is a draft)' },
    ],
    summary: (n) => `${n.cfg.storeName || 'No store chosen yet'}${n.cfg.price ? ` · ${usd(n.cfg.price)}` : ''}${n.cfg.live ? ' · live' : ' · draft'}`,
    world: (n, g) => g.inWorld(n, 'product') ?? null,
    check: (n, g) => {
      const notes = [];
      if (!n.cfg.storeId) notes.push({ level: 'block', text: 'Choose a store, or connect one from the Store list.' });
      const cost = Number(g.source(n, 'product')?.node.out?.product?.unitPrice?.amount);
      if (cost && Number(n.cfg.price) > 0 && Number(n.cfg.price) < cost) notes.push({ level: 'warn', text: `Your price is below the ${usd(cost)} Arcade charges you for it.` });
      if (cost && !(Number(n.cfg.price) > 0)) notes.push({ level: 'warn', text: `No price set, so it will be listed at Arcade’s ${usd(cost)} with no margin.` });
      return notes;
    },
    // Listing in a real store is asked about every time.
    confirm: (n, { ask, source }) => {
      const p = source(n, 'product')?.node.out?.product, shots = source(n, 'shots')?.node.out?.shots?.items || [];
      return ask({ title: `List in ${n.cfg.storeName || 'your store'}?`, ok: n.cfg.live ? 'List it, live' : 'Create the draft',
        body: `<p>This adds a product to your store:</p><ul><li>${esc(p ? p.title : 'the connected product')}</li><li>Price: ${esc(n.cfg.price ? usd(n.cfg.price) : p && p.unitPrice ? usd(p.unitPrice.amount) + ' (Arcade’s price)' : 'Arcade’s price')}</li>
          <li>Pictures: Arcade’s own${shots.length ? `, plus ${count(shots.length, 'model shot')}` : ''}</li><li>${n.cfg.live ? 'Visible to shoppers straight away' : 'Saved as a draft'}</li></ul>` });
    },
    run: async (n, inp) => ({ listed: await App.api(`stores/${n.cfg.storeId}/publish`, { method: 'POST',
      body: { productId: inp.product.productId, price: Number(n.cfg.price) || 0, live: Boolean(n.cfg.live), shotIds: (inp.shots?.items || []).map((i) => i.id),
        collections: n.cfg.collections || [], newCollection: n.cfg.newCollection || '' } }) }),
    preview: (n) => {
      const l = n.out.listed;
      return `<div class="pv-text"><span><b>${esc(l.live ? 'Live' : 'Draft')} in ${esc(l.storeName)}</b> at ${esc(usd(l.price, l.currency))}</span><span><a href="${esc(l.adminUrl)}" target="_blank" rel="noopener">Open it in ${esc(l.platformName)}</a></span></div>`;
    },
    result: (n) => {
      const l = n.out.listed, margin = l.arcadePrice ? Number(l.price) - Number(l.arcadePrice) : null;
      const now = l.now;
      return `<dl class="facts"><dt>Store</dt><dd>${esc(l.storeName)} (${esc(l.platformName)})</dd><dt>Listing</dt><dd>${esc(l.title)} <span class="muted">${l.updated ? '(existing listing updated)' : '(new listing)'}</span></dd><dt>Status</dt><dd>${l.live ? 'Live' : 'Draft'}</dd>
        <dt>Your price</dt><dd><span class="big">${esc(usd(l.price, l.currency))}</span></dd>${l.arcadePrice ? `<dt>Arcade’s price</dt><dd>${esc(usd(l.arcadePrice, l.currency))}</dd><dt>Margin</dt><dd>${esc(usd(margin, l.currency))} each</dd>` : ''}
        <dt>Pictures sent</dt><dd>${l.pictures} from Arcade${l.shots ? `, ${count(l.shots, 'model shot')}` : ''}</dd></dl>
        <p style="margin-top:12px"><a href="${esc(l.adminUrl)}" target="_blank" rel="noopener">Open it in ${esc(l.platformName)}</a>${l.url ? ` · <a href="${esc(l.url)}" target="_blank" rel="noopener">See the page</a>` : ''}</p>
        ${l.note ? `<p class="msg bad">${esc(l.note)}</p>` : ''}
        <h3>What the store has now</h3>${now ? (now.listed ? `<dl class="facts"><dt>Status</dt><dd>${esc(now.status)}</dd><dt>Price</dt><dd>${esc(now.price ? usd(now.price, l.currency) : 'not set')}</dd><dt>In</dt><dd>${esc(now.collections.join(', ') || 'no collection')}</dd></dl>` : '<p class="muted">The store no longer has this listing. Run the step to list it again.</p>') : '<p class="muted">Not read yet.</p>'}
        <p><button class="btn ghost small" data-act="listing-read">Read it back from the store</button></p>`;
    },
    onAct: async (n, act, data, { toast, changed }) => {
      if (act !== 'listing-read' || !n.out?.listed) return;
      try { n.out.listed.now = await App.api(`stores/${n.cfg.storeId}/listing?productId=${encodeURIComponent(n.out.listed.productId)}`); changed(); }
      catch (e) { toast(e.message); }
    },
  };

  const waiting = (list) => list.filter((o) => !o.checkout && o.lines.some((l) => l.arcadeProductId));
  A.NODES.storeOrders = {
    type: 'storeOrders', title: 'Store orders', group: 'Sell', endpoint: 'your store · paid orders', worlds: ['print', 'jewelry'], cost: 'read',
    blurb: 'Reads your store’s paid orders and makes the Arcade checkout for each one.',
    rules: [
      'Arcade takes orders only through its own checkout page. This step makes that checkout for a store order, with the right products and quantities.',
      'You still open the link, type the buyer’s address and pay. Arcade then makes the piece and ships it to your buyer.',
      'An order is matched to Arcade through the listing made by the List in a store step. Other items in an order are left out.',
      'One store order gets one Arcade checkout. Asking again returns the same link.',
      'There is no live feed from the store: run this step again to see new orders.',
    ],
    inputs: [], outputs: [],
    fields: [{ key: 'storeId', kind: 'store', label: 'Store' }],
    summary: (n) => n.cfg.storeName || 'No store chosen yet',
    world: () => null,
    check: (n) => (n.cfg.storeId ? [] : [{ level: 'block', text: 'Choose a store, or connect one from the Store list.' }]),
    run: async (n) => ({ orders: await App.api(`stores/${n.cfg.storeId}/orders`) }),
    preview: (n) => {
      const list = n.out.orders.orders, todo = waiting(list).length;
      return `<div class="pv-text"><span><b>${count(list.length, 'paid order')}</b> in ${esc(n.out.orders.storeName)}</span><span>${todo ? `${todo} waiting for an Arcade checkout` : list.length ? 'Every Arcade order has its checkout' : 'Nothing to send to Arcade'}</span></div>`;
    },
    result: (n) => {
      const o = n.out.orders;
      if (!o.orders.length) return `<p class="muted">No paid, unshipped orders in ${esc(o.storeName)} right now.</p>`;
      return `<div class="prompt-list">${o.orders.map((x) => {
        const ours = x.lines.filter((l) => l.arcadeProductId), address = [x.buyer.name, ...x.buyer.lines, x.buyer.phone, x.buyer.email].filter(Boolean);
        return `<div class="prompt"><div class="top"><b>Order ${esc(x.number)}</b><span class="muted">${esc(x.total)}</span></div>
          <p>${x.lines.map((l) => `${esc(String(l.quantity))} × ${esc(l.title)}${l.arcadeProductId ? '' : ' <span class="muted">(not from Arcade)</span>'}`).join('<br>')}</p>
          <p><b style="color:var(--ink)">Ship to</b><br>${address.map(esc).join('<br>') || '<span class="muted">No address on the order</span>'}</p>
          <div class="acts">${x.checkout ? `<a class="btn small" href="${esc(x.checkout.checkoutUrl)}" target="_blank" rel="noopener" style="text-decoration:none">Open the Arcade checkout</a>`
            : ours.length ? `<button class="btn small" data-act="order-checkout" data-order="${esc(x.id)}">Make the Arcade checkout</button>` : '<span class="muted">Nothing in this order comes from Arcade.</span>'}
            <button class="btn ghost small" data-act="order-copy" data-order="${esc(x.id)}">Copy the address</button></div></div>`;
      }).join('')}</div>`;
    },
    // The buttons inside each order.
    onAct: async (n, act, data, { ask, toast, changed }) => {
      const order = n.out?.orders.orders.find((x) => x.id === data.order);
      if (!order) return;
      if (act === 'order-copy') {
        await navigator.clipboard.writeText([order.buyer.name, ...order.buyer.lines, order.buyer.phone].filter(Boolean).join('\n')).catch(() => {});
        return toast('Address copied. Paste it on Arcade’s checkout page.');
      }
      if (act !== 'order-checkout') return;
      const ours = order.lines.filter((l) => l.arcadeProductId);
      const yes = await ask({ title: `Make the Arcade checkout for order ${order.number}?`, ok: 'Make the checkout',
        body: `<ul>${ours.map((l) => `<li>${esc(String(l.quantity))} × ${esc(l.title)}</li>`).join('')}</ul><p>This creates a real checkout on your Arcade account. Nothing is charged until you pay on Arcade’s page, where you also type the buyer’s address.</p>` });
      if (!yes) return;
      try {
        order.checkout = await App.api(`stores/${n.cfg.storeId}/checkout`, { method: 'POST', body: { orderId: order.id } });
        changed();
        toast(order.checkout.already ? 'This order already had a checkout. Here it is again.' : 'Checkout made. Open it to enter the address and pay.');
      } catch (e) { toast(e.message); }
    },
  };
})();
