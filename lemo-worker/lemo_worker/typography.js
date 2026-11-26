// Trusted, offline typography runtime injected before the generated scene.
(() => {
  const family = 'Motion Kanit';
  const weights = {headline: 800, body: 700, label: 700};
  const proportions = {headline: .104, body: .07, label: .052};
  let fontsReady = false, sceneReady = false, renderScene;
  const faces = [[700, '__KANIT_700__'], [800, '__KANIT_800__']].map(([weight, data]) => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const face = new FontFace(family, bytes, {weight: String(weight)});
    document.fonts.add(face);
    return face.load();
  });
  const ready = Promise.all(faces).then(() => { fontsReady = true; });
  ready.catch(error => { setTimeout(() => { throw error; }, 0); });
  Object.defineProperty(window, 'READY', {get: () => fontsReady && sceneReady && !!renderScene, set: value => { sceneReady = value === true; }});
  Object.defineProperty(window, 'render', {get: () => t => { if (fontsReady && renderScene) return renderScene(t); }, set: value => { renderScene = value; }});

  const proto = CanvasRenderingContext2D.prototype;
  const measure = proto.measureText, fill = proto.fillText, stroke = proto.strokeText;
  function font(ctx) {
    if (!fontsReady) throw Error('Draw text in window.render after MotionText.ready');
    const match = ctx.font.match(/(\d+(?:\.\d+)?)px/);
    const floor = Math.ceil(Math.min(innerWidth, innerHeight) * 48 / 1080);
    const size = Math.max(floor, Number(match?.[1] || floor));
    const weight = /\b(700|800)\b/.exec(ctx.font)?.[1] || (size >= floor * 1.5 ? 800 : 700);
    ctx.font = `${weight} ${size}px "${family}"`;
    return size;
  }
  proto.measureText = function (text) { font(this); return measure.call(this, text); };
  function paint(ctx, method, text, x, y, maxWidth) {
    ctx.save();
    try {
      font(ctx);
      ctx.shadowBlur = ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.min(ctx.lineWidth, 3);
      // Canvas maxWidth squeezes glyphs horizontally. Fit the font uniformly instead.
      if (Number.isFinite(maxWidth) && maxWidth > 0) {
        let size = font(ctx);
        const floor = Math.ceil(Math.min(innerWidth, innerHeight) * 48 / 1080);
        while (measure.call(ctx, text).width > maxWidth && size > floor) {
          ctx.font = `${size >= floor * 1.5 ? 800 : 700} ${--size}px "${family}"`;
        }
        if (measure.call(ctx, text).width > maxWidth) throw Error('Text does not fit: shorten it or wrap at Thai word boundaries');
      }
      return method.call(ctx, text, x, y);
    } finally { ctx.restore(); }
  }
  proto.fillText = function (text, x, y, maxWidth) { return paint(this, fill, text, x, y, maxWidth); };
  proto.strokeText = function (text, x, y, maxWidth) { return paint(this, stroke, text, x, y, maxWidth); };
  window.MotionText = Object.freeze({ready, version: 'all-text-kanit-v2', drawRole(ctx, text, x, y, options = {}) {
    const {role = 'label', size, color = '#193D4E', maxWidth, align = 'center'} = options;
    if (!Object.hasOwn(proportions, role) || !['left', 'center', 'right'].includes(align)) throw Error('Invalid text role or alignment');
    const shortEdge = Math.min(innerWidth, innerHeight);
    // Account for both canvas backing resolution and drawing transforms.
    const transform = ctx.getTransform(), bounds = ctx.canvas.getBoundingClientRect();
    const pixelScale = Math.min(Math.hypot(transform.a, transform.b) * bounds.width / ctx.canvas.width,
      Math.hypot(transform.c, transform.d) * bounds.height / ctx.canvas.height);
    if (!(pixelScale > 0)) throw Error('Draw readable text on a visible canvas');
    const minimum = Math.ceil(shortEdge * proportions[role] / pixelScale);
    const limit = maxWidth ?? Math.floor(innerWidth * .88 / pixelScale);
    if (!Number.isFinite(limit) || limit <= 0) throw Error('Invalid text width');
    ctx.save();
    try {
      let fontSize = Math.max(minimum, Number.isFinite(size) ? Math.ceil(size) : minimum);
      const apply = () => { ctx.font = `${weights[role]} ${fontSize}px "${family}"`; };
      apply();
      const width = measure.call(ctx, text).width;
      if (width > limit) {
        fontSize = Math.max(minimum, Math.floor(fontSize * limit / width));
        apply();
      }
      if (measure.call(ctx, text).width > limit) throw Error(`The ${role} cannot fit at readable size. Shorten or wrap it.`);
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.shadowBlur = ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
      ctx.fillStyle = color;
      fill.call(ctx, text, x, y);
      return fontSize;
    } finally { ctx.restore(); }
  }, draw(ctx, text, x, y, size = 74, color = '#193D4E', outline = null, maxWidth = 960) {
    ctx.save();
    try {
      ctx.font = `${size >= 72 ? 800 : 700} ${Math.max(48, size)}px "${family}"`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (outline) { ctx.lineWidth = 3; ctx.strokeStyle = outline; ctx.strokeText(text, x, y, maxWidth); }
      ctx.fillStyle = color; ctx.fillText(text, x, y, maxWidth);
    } finally { ctx.restore(); }
  }});
})();
