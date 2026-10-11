// The capability catalogue: one entry per thing the Arcade API can do.
// Each entry says what plugs into it, what it produces, the rules that decide
// whether it can run, and the calls it makes. To add a capability, add an entry.
(function () {
  const NODES = {};
  const BOTH = ['print', 'jewelry'];
  const add = (type, def) => { NODES[type] = { type, inputs: [], outputs: [], fields: [], rules: [], ...def }; };
  const block = (text) => ({ level: 'block', text });
  const warn = (text) => ({ level: 'warn', text });
  const colorList = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
  const int = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };

  // ---------- Start ----------
  add('category', {
    title: 'Category', group: 'Start', endpoint: 'categories/get', worlds: BOTH, cost: 'read',
    blurb: 'Picks what gets made: a print good or a piece of jewelry.',
    rules: [
      'Every category is either print or jewelry. That decides which steps can follow it.',
      'Running it lists the options Arcade can make, such as the metals for a ring.',
    ],
    outputs: [{ key: 'category', type: 'category', label: 'Category' }],
    fields: [{ key: 'categoryId', kind: 'category', label: 'Category' }],
    world: (n, g) => g.categoryWorld(n.cfg.categoryId),
    check: (n) => (n.cfg.categoryId ? [] : [block('Choose a category.')]),
    run: async (n, inp, ctx) => {
      const r = await ctx.arcade('categories/get', { categoryId: n.cfg.categoryId, selections: {} });
      const listed = ctx.category(n.cfg.categoryId) || {};
      return { category: { categoryId: r.categoryId, name: r.name, world: r.world, imageUrl: listed.imageUrl || null,
        options: r.options || [], selections: r.selections || {}, canManufacture: r.canManufacture } };
    },
  });

  add('savedDesign', {
    title: 'Saved design', group: 'Start', endpoint: 'patterns/get', worlds: BOTH, cost: 'read',
    blurb: 'Starts from a design already on your account, so nothing is generated again.',
    rules: ['Arcade does not say whether a saved design is print or jewelry. If it is jewelry, refine steps after it will fail.'],
    outputs: [{ key: 'pattern', type: 'pattern', label: 'Design' }],
    fields: [{ key: 'patternId', kind: 'pick', list: 'patterns/list', label: 'Design', idKey: 'patternId' }],
    world: () => null,
    check: (n) => (n.cfg.patternId ? [] : [block('Choose a saved design.')]),
    run: async (n, inp, ctx) => ({ pattern: await ctx.readPattern(n.cfg.patternId, null) }),
  });

  add('savedProduct', {
    title: 'Saved product', group: 'Start', endpoint: 'products/get', worlds: BOTH, cost: 'read',
    blurb: 'Starts from a product already on your account.',
    outputs: [{ key: 'product', type: 'product', label: 'Product' }],
    fields: [{ key: 'productId', kind: 'pick', list: 'products/list', label: 'Product', idKey: 'productId' }],
    world: (n) => n.out?.product?.world ?? null,
    check: (n) => (n.cfg.productId ? [] : [block('Choose a saved product.')]),
    run: async (n, inp, ctx) => ({ product: await ctx.readProduct(n.cfg.productId, 1, null) }),
  });

  // ---------- Design ----------
  add('design', {
    title: 'Design', group: 'Design', endpoint: 'patterns/create', worlds: BOTH, cost: 'create',
    blurb: 'Turns a prompt into a design. With a category connected, Arcade builds the product too.',
    rules: [
      'No category: a print design only.',
      'Print category: the design plus a product, with options picked by Arcade.',
      'Jewelry category: one prompt makes the piece and its product. Name the metal in the prompt.',
      'Jewelry takes a prompt only. Style model, colors and reference images are refused.',
      'Arcade checks a jewelry prompt against the category first. A mismatch returns 400 and nothing is made.',
      'A jewelry job can fail when no maker can price the design. Try a different metal.',
    ],
    inputs: [{ key: 'category', type: 'category', label: 'Category', optional: true }],
    outputs: [
      { key: 'pattern', type: 'pattern', label: 'Design' },
      { key: 'product', type: 'product', label: 'Product', when: (n, g) => g.connected(n, 'category'),
        whyNot: 'That Design step has no category, so it makes a design with no product. Connect a Category to it.' },
    ],
    fields: [
      { key: 'prompt', kind: 'textarea', label: 'Prompt', max: 1000, placeholder: 'Describe the piece or the pattern', assist: true },
      { key: 'modelId', kind: 'model', label: 'Style model', printOnly: true },
      { key: 'colors', kind: 'text', label: 'Colors', placeholder: '#1F3A8A, #F4EDE0', printOnly: true },
    ],
    world: (n, g) => (g.connected(n, 'category') ? g.inWorld(n, 'category') : 'print'),
    check: (n, g) => {
      const out = [];
      if (!String(n.cfg.prompt || '').trim()) out.push(block('Write a prompt.'));
      if (g.inWorld(n, 'category') === 'jewelry' && (n.cfg.modelId || colorList(n.cfg.colors).length)) {
        out.push(warn('Jewelry takes a prompt only, so the style model and colors are left out of the request.'));
      }
      return out;
    },
    run: async (n, inp, ctx) => {
      const cat = inp.category;
      const jewelry = cat?.world === 'jewelry';
      const body = { requestId: ctx.uid('design'), prompt: String(n.cfg.prompt).trim() };
      if (cat) body.categoryId = cat.categoryId;
      if (!jewelry) {
        if (n.cfg.modelId) body.modelId = n.cfg.modelId;
        const colors = colorList(n.cfg.colors);
        if (colors.length) body.colors = colors;
      }
      const job = await ctx.job('patterns/create', body, cat ? 'Designing and building the product' : 'Generating the design');
      if (!job.result?.patternId) throw new Error('The job finished without a design.');
      const world = cat ? cat.world : 'print';
      const out = { pattern: await ctx.readPattern(job.result.patternId, world) };
      if (job.result.productId) out.product = await ctx.readProduct(job.result.productId, 1, world);
      return out;
    },
  });

  // ---------- Refine (print only) ----------
  const REFINE_RULES = [
    'Print designs only.',
    'A jewelry design is made for its own product, so Arcade refuses to refine it (400). Fork the Design step and change its prompt instead.',
    'Each refine makes a new design. The one before it is kept.',
  ];
  function refine(type, title, endpoint, blurb, fields, body, extraCheck) {
    add(type, {
      title, group: 'Refine', endpoint, worlds: ['print'], cost: 'create', blurb, rules: REFINE_RULES, fields,
      inputs: [{ key: 'pattern', type: 'pattern', label: 'Design' }],
      outputs: [{ key: 'pattern', type: 'pattern', label: 'Design' }],
      world: (n, g) => g.inWorld(n, 'pattern') ?? null,
      check: (n, g) => {
        const out = [];
        if (g.inWorld(n, 'pattern') === 'jewelry') {
          out.push(block('Jewelry designs can’t be refined. Fork the Design step and change its prompt instead.'));
        }
        if (extraCheck) out.push(...extraCheck(n, g));
        return out;
      },
      run: async (n, inp, ctx) => {
        const req = { requestId: ctx.uid(type), patternId: inp.pattern.patternId, ...body(n.cfg, inp.pattern) };
        const job = await ctx.job(endpoint, req, `${title}: working on the design`);
        if (!job.result?.patternId) throw new Error('The job finished without a design.');
        return { pattern: await ctx.readPattern(job.result.patternId, 'print') };
      },
    });
  }

  refine('edit', 'Edit', 'patterns/refine/edit', 'Changes a design from a written instruction.',
    [{ key: 'instruction', kind: 'textarea', label: 'Instruction', max: 1000, placeholder: 'Make the flowers larger' },
     { key: 'colors', kind: 'text', label: 'Colors', placeholder: 'Optional. #1F3A8A, #F4EDE0' }],
    (cfg) => { const b = { instruction: String(cfg.instruction).trim() }; const c = colorList(cfg.colors); if (c.length) b.colors = c; return b; },
    (n) => (String(n.cfg.instruction || '').trim() ? [] : [block('Write an instruction.')]));

  refine('recolor', 'Recolor', 'patterns/refine/recolor', 'Swaps a design’s main colors for ones you pick.',
    [{ key: 'clusters', kind: 'clusters', label: 'Colors' }],
    (cfg) => ({ colors: cfg.clusters.map((c) => ({ clusterId: c.clusterId, color: c.to })) }),
    (n, g) => {
      const src = g.source(n, 'pattern');
      const pid = src?.node.out?.pattern?.patternId;
      if (!n.cfg.clusters?.length || (pid && n.cfg.clustersFor !== pid)) return [block('Load the design’s colors first.')];
      if (!n.cfg.clusters.some((c) => c.to.toLowerCase() !== c.color.toLowerCase())) return [block('Change at least one color.')];
      return [];
    });

  refine('crop', 'Crop', 'patterns/refine/crop', 'Cuts a design down to a rectangle.',
    [{ key: 'left', kind: 'number', label: 'Left', default: 0, min: 0 }, { key: 'top', kind: 'number', label: 'Top', default: 0, min: 0 },
     { key: 'width', kind: 'number', label: 'Width', default: 768, min: 16 }, { key: 'height', kind: 'number', label: 'Height', default: 768, min: 16 }],
    (cfg) => ({ rectangle: { left: int(cfg.left, 0), top: int(cfg.top, 0), width: int(cfg.width, 768), height: int(cfg.height, 768) } }));

  refine('seamless', 'Make seamless', 'patterns/refine/makeSeamless', 'Turns a square area into a repeat with no visible seam.',
    [{ key: 'left', kind: 'number', label: 'Left', default: 0, min: 0 }, { key: 'top', kind: 'number', label: 'Top', default: 0, min: 0 },
     { key: 'size', kind: 'number', label: 'Tile size', default: 512, min: 16 }],
    (cfg) => ({ tile: { left: int(cfg.left, 0), top: int(cfg.top, 0), size: int(cfg.size, 512) } }));

  const SIZE_FIELDS = [{ key: 'targetWidth', kind: 'number', label: 'Width', default: 1536, min: 16, max: 1536 },
    { key: 'targetHeight', kind: 'number', label: 'Height', default: 1024, min: 16, max: 1536 }];
  const sizeBody = (cfg) => ({ targetWidth: int(cfg.targetWidth, 1536), targetHeight: int(cfg.targetHeight, 1024) });
  refine('extendPattern', 'Extend pattern', 'patterns/refine/extendPattern', 'Grows a repeating pattern to a larger size.', SIZE_FIELDS, sizeBody);
  refine('extendScene', 'Extend scene', 'patterns/refine/extendScene', 'Paints past the edges of a picture that does not repeat.', SIZE_FIELDS, sizeBody);

  refine('fix', 'Fix deformities', 'patterns/refine/fixDeformity', 'Finds and repairs malformed details.',
    [{ key: 'maxPasses', kind: 'number', label: 'Passes', default: 1, min: 1, max: 3 },
     { key: 'force', kind: 'check', label: 'Repair even if the scan finds nothing' }],
    (cfg) => ({ maxPasses: Math.min(3, Math.max(1, int(cfg.maxPasses, 1))), ...(cfg.force ? { force: true } : {}) }));

  // ---------- Product ----------
  add('product', {
    title: 'Build product', group: 'Product', endpoint: 'products/create', worlds: ['print'], cost: 'create',
    blurb: 'Puts a print design on a product, with the options you choose.',
    rules: [
      'Print only. It needs a print design and a print category.',
      'Jewelry is refused here. A jewelry Design step already makes its product.',
      'Not every mix of options can be made. Run the Category step to see which values Arcade can make.',
    ],
    inputs: [{ key: 'pattern', type: 'pattern', label: 'Design' }, { key: 'category', type: 'category', label: 'Category' }],
    outputs: [{ key: 'product', type: 'product', label: 'Product' }],
    fields: [{ key: 'selections', kind: 'options', label: 'Options' }, { key: 'fill', kind: 'check', label: 'Fill the product if the shapes don’t match' }],
    world: () => 'print',
    check: (n, g) => {
      const out = [];
      if (g.inWorld(n, 'pattern') === 'jewelry') out.push(block('A jewelry design already has its product. Use the Product output of its Design step.'));
      if (g.inWorld(n, 'category') === 'jewelry') out.push(block('Arcade refuses jewelry categories here. Connect that category to a Design step instead.'));
      return out;
    },
    run: async (n, inp, ctx) => {
      const picked = await ctx.arcade('categories/get', { categoryId: inp.category.categoryId, selections: n.cfg.selections || {} });
      if (!picked.canManufacture) throw new Error('These options can’t be made together. Change one that Arcade marks unavailable.');
      const body = { requestId: ctx.uid('product'), patternId: inp.pattern.patternId, categoryId: inp.category.categoryId, selections: picked.selections };
      if (n.cfg.fill) body.fit = { mode: 'fill' };
      const job = await ctx.job('products/create', body, 'Building the product');
      if (!job.result?.productId) throw new Error('The job finished without a product.');
      return { product: await ctx.readProduct(job.result.productId, 1, 'print') };
    },
  });

  add('price', {
    title: 'Price', group: 'Product', endpoint: 'products/get', worlds: BOTH, cost: 'read',
    blurb: 'Reads the guaranteed unit price, maker and images for a quantity.',
    rules: [
      'The price is for one unit at the quantity you ask for, before volume discount.',
      'The price can come back empty for a moment after a product is built. Run it again.',
      'Image links expire. Running this step again renews them.',
    ],
    inputs: [{ key: 'product', type: 'product', label: 'Product' }],
    outputs: [{ key: 'product', type: 'product', label: 'Product' }],
    fields: [{ key: 'quantity', kind: 'number', label: 'Quantity', default: 1, min: 1 }],
    world: (n, g) => g.inWorld(n, 'product') ?? null,
    run: async (n, inp, ctx) => ({ product: await ctx.readProduct(inp.product.productId, Math.max(1, int(n.cfg.quantity, 1)), inp.product.world) }),
  });

  // ---------- Sell ----------
  add('checkout', {
    title: 'Checkout link', group: 'Sell', endpoint: 'checkouts/create', worlds: BOTH, cost: 'checkout',
    blurb: 'Makes a link to Arcade’s hosted checkout for one or more products.',
    rules: [
      'This creates a real checkout on your account. Nothing is charged until someone pays on Arcade’s page.',
      'Quantity 1 needs drop-ship unless the account has a subscription. Otherwise Arcade returns 412.',
      'It never runs as part of Run flow. You confirm each one.',
    ],
    inputs: [{ key: 'product', type: 'product', label: 'Products', multi: true }],
    outputs: [{ key: 'checkout', type: 'checkout', label: 'Checkout' }],
    fields: [{ key: 'quantity', kind: 'number', label: 'Quantity each', default: 1, min: 1, max: 1000 },
      { key: 'dropShip', kind: 'check', label: 'Drop-ship to the buyer', default: true }],
    world: (n, g) => g.inWorld(n, 'product') ?? null,
    check: (n) => (int(n.cfg.quantity, 1) === 1 && !n.cfg.dropShip
      ? [warn('Quantity 1 without drop-ship returns 412 unless the account has a subscription.')] : []),
    run: async (n, inp, ctx) => {
      const quantity = Math.min(1000, Math.max(1, int(n.cfg.quantity, 1)));
      const lines = inp.product.map((p) => ({ productId: p.productId, quantity }));
      const c = await ctx.arcade('checkouts/create', { requestId: ctx.uid('checkout'), lines, dropShip: Boolean(n.cfg.dropShip) });
      return { checkout: { checkoutId: c.checkoutId, checkoutUrl: c.checkoutUrl, quantity, titles: inp.product.map((p) => p.title) } };
    },
  });

  add('order', {
    title: 'Order status', group: 'Sell', endpoint: 'orders/get', worlds: BOTH, cost: 'read',
    blurb: 'Checks whether a checkout has been paid and where the order is.',
    rules: ['Arcade answers 404 until the checkout is paid. That is expected, not a failure.', 'Arcade has no webhooks, so run this again to see progress.'],
    inputs: [{ key: 'checkout', type: 'checkout', label: 'Checkout' }],
    world: () => null,
    run: async (n, inp, ctx) => {
      try {
        const o = await ctx.arcade('orders/get', { checkoutId: inp.checkout.checkoutId });
        return { order: { paid: true, orderNumber: o.orderNumber, status: o.status, total: o.total } };
      } catch (e) {
        if (e.status === 404) return { order: { paid: false } };
        throw e;
      }
    },
  });

  // Capabilities the API has but this bench can't run. Shown so nobody goes looking.
  const UNAVAILABLE = [
    { title: 'Upscale', endpoint: 'patterns/refine/upscale', why: 'Arcade Studio only. The public API returns 403.' },
    { title: 'Edit a region', endpoint: 'patterns/refine/editRegion', why: 'Needs a painted mask. Not wired into the bench yet.' },
    { title: 'Reference image', endpoint: 'references/create', why: 'Print only, up to 3 per design. Upload is not wired in yet.' },
  ];

  const GROUPS = ['Start', 'Design', 'Refine', 'Product', 'Sell'];

  // Starter flows. Categories are named, not hard-coded: IDs are looked up from the account.
  const TEMPLATES = [
    { id: 'jewelry', name: 'Jewelry: prompt to checkout link',
      nodes: [
        { id: 'c1', type: 'category', x: 40, y: 80, cfg: { categoryName: 'Rings' } },
        { id: 'd1', type: 'design', x: 370, y: 40, cfg: { prompt: 'A 925 sterling silver ring with a wide hammered band, no stones' } },
        { id: 'p1', type: 'price', x: 700, y: 40, cfg: { quantity: 1 } },
        { id: 'k1', type: 'checkout', x: 1030, y: 40, cfg: { quantity: 1, dropShip: true } },
      ],
      edges: [['c1', 'category', 'd1', 'category'], ['d1', 'product', 'p1', 'product'], ['p1', 'product', 'k1', 'product']] },
    { id: 'variations', name: 'Variations: one ring in three metals',
      nodes: [
        { id: 'c1', type: 'category', x: 40, y: 480, cfg: { categoryName: 'Rings' } },
        { id: 'd1', type: 'design', x: 370, y: 40, cfg: { prompt: 'A 925 sterling silver signet ring with an oval face, no stones' } },
        { id: 'd2', type: 'design', x: 370, y: 480, cfg: { prompt: 'A 14k gold vermeil signet ring with an oval face, no stones' } },
        { id: 'd3', type: 'design', x: 370, y: 920, cfg: { prompt: 'A 14k yellow gold signet ring with an oval face, no stones' } },
        { id: 'p1', type: 'price', x: 700, y: 40, cfg: { quantity: 1 } },
        { id: 'p2', type: 'price', x: 700, y: 480, cfg: { quantity: 1 } },
        { id: 'p3', type: 'price', x: 700, y: 920, cfg: { quantity: 1 } },
      ],
      edges: [['c1', 'category', 'd1', 'category'], ['c1', 'category', 'd2', 'category'], ['c1', 'category', 'd3', 'category'],
        ['d1', 'product', 'p1', 'product'], ['d2', 'product', 'p2', 'product'], ['d3', 'product', 'p3', 'product']] },
    { id: 'print', name: 'Print: design, edit, product, price',
      nodes: [
        { id: 'd1', type: 'design', x: 40, y: 40, cfg: { prompt: 'Small blue and white block-print florals on natural linen' } },
        { id: 'e1', type: 'edit', x: 370, y: 40, cfg: { instruction: 'Make the flowers larger and add a thin indigo border' } },
        { id: 'c1', type: 'category', x: 370, y: 470, cfg: { categoryName: 'Napkins' } },
        { id: 'b1', type: 'product', x: 700, y: 40, cfg: {} },
        { id: 'p1', type: 'price', x: 1030, y: 40, cfg: { quantity: 4 } },
      ],
      edges: [['d1', 'pattern', 'e1', 'pattern'], ['e1', 'pattern', 'b1', 'pattern'], ['c1', 'category', 'b1', 'category'], ['b1', 'product', 'p1', 'product']] },
    { id: 'refused', name: 'What Arcade refuses, and why',
      nodes: [
        { id: 'c1', type: 'category', x: 40, y: 330, cfg: { categoryName: 'Pendant Necklace' } },
        { id: 'd1', type: 'design', x: 370, y: 280, cfg: { prompt: 'A 14k gold vermeil pendant necklace with a small crescent moon' } },
        { id: 'e1', type: 'edit', x: 700, y: 20, cfg: { instruction: 'Make the moon larger' } },
        { id: 'b1', type: 'product', x: 700, y: 400, cfg: {} },
        { id: 'p1', type: 'price', x: 700, y: 740, cfg: { quantity: 1 } },
      ],
      edges: [['c1', 'category', 'd1', 'category'], ['d1', 'pattern', 'e1', 'pattern'], ['d1', 'pattern', 'b1', 'pattern'],
        ['c1', 'category', 'b1', 'category'], ['d1', 'product', 'p1', 'product']] },
  ];

  window.ArcadeNodes = { NODES, GROUPS, TEMPLATES, UNAVAILABLE };
})();
