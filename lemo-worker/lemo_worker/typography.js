// Trusted, offline typography runtime injected before the generated scene.
(() => {
  const family = 'Motion Kanit';
  const version = '__TEXT_VERSION__';
  const words = new Intl.Segmenter('th',{granularity:'word'});
  const graphemes = new Intl.Segmenter('th',{granularity:'grapheme'});
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
    if (version==='all-text-kanit-v2') throw Error('Draw scene text with MotionText.drawRole so its role and safe area are known');
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
  window.MotionText = Object.freeze({ready, version, drawRole(ctx, text, x, y, options = {}) {
    const {role = 'label', size, color = '#193D4E', maxWidth, align = 'center'} = options;
    if (!Object.hasOwn(proportions, role) || !['left', 'center', 'right'].includes(align)) throw Error('Invalid text role or alignment');
    const canvas = ctx.canvas, bounds = canvas.getBoundingClientRect();
    const sx = bounds.width / canvas.width, sy = bounds.height / canvas.height;
    const m = ctx.getTransform(), zoom = Math.min(Math.hypot(m.a*sx, m.b*sy), Math.hypot(m.c*sx, m.d*sy));
    if (!(zoom > 0)) throw Error('Draw readable text on a visible canvas');
    const edge = Math.min(innerWidth, innerHeight), margin = edge * .04;
    const left = Math.max(0,-bounds.left)+margin, right = Math.min(bounds.width,innerWidth-bounds.left)-margin;
    const top = Math.max(0,-bounds.top)+margin, bottom = Math.min(bounds.height,innerHeight*.8-bounds.top)-margin;
    const limit = Math.min(right-left, maxWidth == null ? edge*.88 : maxWidth*Math.hypot(m.a*sx,m.b*sy));
    if (!(limit > 0) || !Number.isFinite(limit)) throw Error('Invalid text width');
    const minimum = Math.ceil(edge * proportions[role]);
    let pixels = Math.max(minimum, Number.isFinite(size) ? Math.ceil(size*zoom) : minimum);
    ctx.save();
    try {
      // The anchor follows the camera. Layout in display pixels keeps the letters upright and readable.
      ctx.setTransform(1/sx,0,0,1/sy,0,0);
      const apply=()=>{ctx.font=`${weights[role]} ${pixels}px "${family}"`;};
      apply();
      const paragraphs=String(text).split(/\r?\n/);
      const width=s=>measure.call(ctx,s).width;
      const widest=Math.max(...paragraphs.map(width));
      if(widest>limit){pixels=Math.max(minimum,Math.floor(pixels*limit/widest));apply();}
      const lines=[];
      for(const paragraph of paragraphs){
        let line='';
        const append=part=>{
          if(line && width(line+part)>limit){lines.push(line.trimEnd());line='';}
          line+=line ? part : part.trimStart();
        };
        for(const {segment} of words.segment(paragraph)){
          if(width(segment)<=limit) append(segment);
          else for(const {segment:g} of graphemes.segment(segment)){
            if(width(g)>limit) throw Error('A character cannot fit the text area');
            append(g);
          }
        }
        lines.push(line.trimEnd());
      }
      ctx.textAlign=align;ctx.textBaseline='middle';
      const metrics=lines.map(line=>measure.call(ctx,line));
      const leading=Math.ceil(pixels*1.5);
      const ascent=Math.max(...metrics.map(v=>v.actualBoundingBoxAscent),pixels*.55);
      const descent=Math.max(...metrics.map(v=>v.actualBoundingBoxDescent),pixels*.5);
      const height=ascent+descent+(lines.length-1)*leading;
      if(height>bottom-top)throw Error('Shorten the copy or split it across scenes');
      const y0=Math.max(top+ascent,Math.min(bottom-height+ascent,(m.b*x+m.d*y+m.f)*sy-(lines.length-1)*leading/2));
      ctx.shadowBlur=ctx.shadowOffsetX=ctx.shadowOffsetY=0;
      ctx.fillStyle=color;
      const hex=String(ctx.fillStyle).match(/^#([0-9a-f]{6})$/i);
      if(!hex)throw Error('Use an opaque text color');
      const rgb=hex[1].match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
      ctx.strokeStyle=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.179?'#000000':'#ffffff';
      ctx.lineJoin='round';ctx.lineWidth=Math.max(2,pixels*.075);
      for(const [i,line] of lines.entries()){
        const ink=metrics[i],anchor=(m.a*x+m.c*y+m.e)*sx;
        const xx=Math.max(left+ink.actualBoundingBoxLeft,Math.min(right-ink.actualBoundingBoxRight,anchor));
        stroke.call(ctx,line,xx,y0+i*leading);
        fill.call(ctx,line,xx,y0+i*leading);
      }
      return pixels/zoom;
    } finally { ctx.restore(); }
  }, draw(ctx, text, x, y, size = 74, color = '#193D4E', outline = null, maxWidth = 960) {
    if (version==='all-text-kanit-v2') {
      return this.drawRole(ctx,text,x,y,{role:size>=72?'headline':size>=50?'body':'label',size,color:outline||color,maxWidth});
    }
    ctx.save();
    try {
      ctx.font = `${size >= 72 ? 800 : 700} ${Math.max(48, size)}px "${family}"`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (outline) { ctx.lineWidth = 3; ctx.strokeStyle = outline; ctx.strokeText(text, x, y, maxWidth); }
      ctx.fillStyle = color; ctx.fillText(text, x, y, maxWidth);
    } finally { ctx.restore(); }
  }});
})();
