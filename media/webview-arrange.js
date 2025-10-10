// Arrange module: positions modules and functions
(function(){
  const D = globalThis.DepViz || (globalThis.DepViz = {});
  const S = D.state;
  const U = D.util || {};
  const C = D.consts || {};
  const meas = U.textMeasurer || (t=>t.length*8);
  const MOD_PAD = C.MOD_PAD || 10;
  const MOD_HEAD = C.MOD_HEAD || 28;
  const SLOT_H = C.SLOT_H || 50;
  const GAP = C.GAP || 8;

  function autoArrangeByFolders(){
    const mods = S.data.nodes.filter(n => n.kind==='module');
    const buckets = new Map();
    for (const m of mods) {
      const parts = (m.label || '').split(/[\\/]/);
      const depth = Math.max(0, parts.length - 1);
      if (!buckets.has(depth)) buckets.set(depth, []);
      buckets.get(depth).push(m);
    }
    const gapX = 160, gapY = 120;
    const depths = Array.from(buckets.keys()).sort((a,b)=>a-b);
    for (const d of depths) {
      const list = buckets.get(d).sort((a,b)=>a.label.localeCompare(b.label));
      let y = 0;
      for (const m of list) {
        const kids = S.data.nodes.filter(k => k.parent===m.id && k.docked);
        let childW = 160; for (const f of kids) childW = Math.max(childW, meas(f.label, 12, false) + 20);
        const w = Math.max(220, meas(m.label, 12, true) + MOD_PAD*2, childW + MOD_PAD*2);
        const h = MOD_HEAD + MOD_PAD + (m.collapsed?0:kids.length*(SLOT_H + GAP)) + MOD_PAD;
        m.x = d * (280 + gapX);
        m.y = y;
        y += h + gapY;
      }
    }
  }

  function autoArrangeBalanced(){
    const mods = S.data.nodes.filter(n=>n.kind==='module');
    const sizes = mods.map(m=>{
      const kids = S.data.nodes.filter(k=>k.parent===m.id && k.docked);
      const h = MOD_HEAD + MOD_PAD + (m.collapsed?0:kids.length*(SLOT_H+GAP)) + MOD_PAD;
      const w = Math.max(220, meas(m.label,12,true)+MOD_PAD*2);
      return {m,h,w};
    });
    const N = sizes.length;
    const cols = Math.max(1, Math.round(Math.sqrt(N)));
    const gapX=160, gapY=120;
    const rows = Array.from({length: Math.ceil(N/cols)}, ()=>[]);
    sizes.sort((a,b)=>b.h-a.h).forEach((s,i)=>rows[i%rows.length].push(s));
    let y=0;
    for (const row of rows){
      let x=0, rowH=0;
      for (const {m,h,w} of row){
        m.x = x; m.y = y;
        x += Math.max(280,w) + gapX;
        rowH = Math.max(rowH, h);
      }
      y += rowH + gapY;
    }
  }

  // Same fan-out as import drop (triangular sequence, 320x220 footprint)
  function autoArrangeLikeImport(origin){
    const mods = S.data.nodes.filter(n=>n.kind==='module');
    if (!mods.length) return;
    const spacingX = 320, spacingY = 220;
    const start = origin || S.spawnOrigin || S.lastCursorWorld || { x: 40, y: 40 };
    let seq = 0;
    const nextPos = (o, dx, dy) => {
      const k = seq++;
      const row = Math.floor((-1 + Math.sqrt(1 + 8*k)) / 2);
      const used = row * (row + 1) / 2;
      const col = k - used;
      return { x: o.x + (row - col) * dx, y: o.y + col * dy };
    };
    const sorted = mods.slice().sort((a,b)=>String(a.label||'').localeCompare(String(b.label||'')));
    for (const m of sorted){
      const p = nextPos(start, spacingX, spacingY);
      m.x = p.x; m.y = p.y;
    }
  }

  D.arrange = Object.freeze({ autoArrangeByFolders, autoArrangeBalanced, autoArrangeLikeImport });
})();

