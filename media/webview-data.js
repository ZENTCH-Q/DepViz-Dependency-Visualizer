// Data module: merge artifacts, normalize nodes, infer edges
(function(){
  const D = globalThis.DepViz || (globalThis.DepViz = {});
  const S = D.state;
  const toPosix = (s)=> String(s||'').replace(/\\/g,'/');
  function normalizeImportLabel(fromFileLabel, spec){
    const isRel = /^[./]/.test(spec);
    if (!isRel) return spec; // bare module -> as-is
    const fromDir = toPosix(fromFileLabel).split('/').slice(0,-1).join('/');
    // Join and normalize ./ and ../ segments
    const raw = toPosix(`${fromDir}/${spec}`).replace(/\/+/g,'/').replace(/^\/+/, '');
    const parts = [];
    for (const seg of raw.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (parts.length) parts.pop(); continue; }
      parts.push(seg);
    }
    let joined = parts.join('/');
    // strip common language suffixes
    joined = joined.replace(/\.(tsx?|mjs|cjs|jsx?|py|go|rs|rb|php|java|kt|cs)$/i, '');
    joined = joined.replace(/\/(index|__init__)$/i, '');
    return joined;
  }
  const makeModId = (label)=> `mod:${toPosix(label)}`;
  function recomputeMissingEdges() {
    const funcs = S.data.nodes.filter(n=>n.kind==='func');
    const modules = new Map(S.data.nodes.filter(n=>n.kind==='module').map(m=>[m.id, m]));
    const nameToFns = new Map(); // function name -> array of nodes
    for (const f of funcs){
      const nm = (f.label||'').replace(/^.*\s+([A-Za-z_][A-Za-z0-9_]*)\(\).*$/,'$1');
      if (!nm) continue; if (!nameToFns.has(nm)) nameToFns.set(nm, []); nameToFns.get(nm).push(f);
    }
    // compute import preferences per module by re-parsing module.source
    const importPrefs = new Map(); // moduleId -> Set(moduleId)
    for (const [mid, m] of modules){
      const src = String(m.source || '');
      const targets = new Set();
      // Python-like
      src.replace(/^(?:from\s+([\w\.]+)\s+import|import\s+([\w\.]+))/gm, (_,a,b)=>{
        const t=a||b; if (!t) return '';
        const label = normalizeImportLabel(m.label||'', t);
        targets.add(makeModId(label));
        return '';
      });
      // JS/TS/CommonJS (capture all 4 alternatives)
      src.replace(/^\s*(?:import\s+(?:[^'"\n]+)\s+from\s+['"]([^'"\n]+)['"]|import\s+['"]([^'"\n]+)['"]|const\s+[^=]+=\s*require\(\s*['"]([^'"\n]+)['"]\s*\)|require\(\s*['"]([^'"\n]+)['"]\s*\))/gm,
        (_,$1,$2,$3,$4)=>{
          const t=$1||$2||$3||$4; if (!t) return '';
          const label = normalizeImportLabel(m.label||'', t);
          targets.add(makeModId(label));
          return '';
        });
      const exist = new Set();
      for (const id of targets) {
        if (modules.has(id)) exist.add(id);
      }
      importPrefs.set(mid, exist);
    }
    const have = new Set(S.data.edges.map(e=>`${e.from}->${e.to}:${e.type}`));

    // 2) Infer CALL edges between functions using import preferences
    for (const f of funcs){
      const code = String(f.snippet||'');
      const p = D.indices?.nodeMap?.get(f.parent);
      const callerMod = (p && p.kind === 'class') ? p.parent : f.parent;
      const prefMods = importPrefs.get(callerMod) || new Set();
      const names = new Set();
      const KW = /^(new|class|if|for|while|switch|return|function)$/;
      code.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, (match, $name, idx) => {
        // emulate (?<!\.) by checking previous char
        const prev = idx > 0 ? code[idx - 1] : '';
        if (prev === '.') return match;
        const name = String($name);
        if (!KW.test(name)) names.add(name);
        return match;
      });
      for (const name of names){
        const cands = nameToFns.get(name) || [];
        if (!cands.length) continue;
        let best = null;
        for (const cand of cands){
          if (cand.id === f.id) continue;
          const cp = D.indices?.nodeMap?.get(cand.parent);
          const candMod = (cp && cp.kind === 'class') ? cp.parent : cand.parent;
          if (prefMods.has(candMod)) { best = cand; break; }
        }
        if (!best) best = cands.find(c=>c.id!==f.id) || null;
        if (best){
          const key = `${f.id}->${best.id}:call`;
          if (!have.has(key)) {
            S.data.edges.push({ from: f.id, to: best.id, type: 'call', provenance: 'heuristic', confidence: 0.6 });
            have.add(key);
          }
        }
      }
    }
  }

  function h(s){
    let h = 2166136261 >>> 0;
    for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h>>>0).toString(16);
  }

  function mergeArtifacts(payload){
    if (payload.fullRescan && payload.sourceId) {
      const keep = [];
      for (const n of (S.data.nodes || [])) {
        // assume nodes may carry sourceId; if not, keep them
        if (n.sourceId && n.sourceId === payload.sourceId) continue;
        keep.push(n);
      }
      S.data.nodes = keep;
      // Also drop edges incident to evicted nodes
      const alive = new Set(S.data.nodes.map(n=>n.id));
      S.data.edges = (S.data.edges || []).filter(e => alive.has(e.from) && alive.has(e.to));
    }

    // Build index for upsert
    const byId = new Map(S.data.nodes.map(n => [n.id, n]));
    for (const incoming of (payload.nodes || [])) {
      // default docking for funcs
      if (incoming.kind === 'func' && typeof incoming.docked !== 'boolean') incoming.docked = true;
      // attach sourceId if the batch provides it (helps future rescans)
      if (payload.sourceId && !incoming.sourceId) incoming.sourceId = payload.sourceId;

      const existing = byId.get(incoming.id);
      if (!existing) {
        S.data.nodes.push(incoming);
        byId.set(incoming.id, incoming);
        continue;
      }
      // Upsert: prefer incoming fields; preserve runtime-only layout fields if not provided
      const preserved = {
        x: existing.x, y: existing.y, dx: existing.dx, dy: existing.dy,
        collapsed: existing.collapsed, docked: existing.docked,
        _w: existing._w
      };
      const merged = Object.assign({}, existing, incoming);
      // keep layout if incoming doesn’t specify
      for (const k of Object.keys(preserved)) {
        if (typeof merged[k] === 'undefined') merged[k] = preserved[k];
      }
      Object.assign(existing, merged);
    }
    const ekeys = new Set(S.data.edges.map(e => `${e.from}->${e.to}:${e.type}`));
    for (const e of (payload.edges || [])) {
      const key = `${e.from}->${e.to}:${e.type}`;
      const from = S.data.nodes.find(n=>n.id===e.from);
      const to = S.data.nodes.find(n=>n.id===e.to);
      if (from && to && from.kind==='module' && to.kind==='func' && to.parent===from.id && e.type==='import') continue;
      if (!ekeys.has(key)) { S.data.edges.push(e); ekeys.add(key); }
    }
  }

  function normalizeNodes(){
    for (const n of S.data.nodes) {
      if (n.kind==='func' && typeof n.docked==='undefined') n.docked = true;
      if (n.kind==='module' && typeof n.collapsed==='undefined') n.collapsed = true;
    }
  }

  function setAllModulesCollapsed(collapsed){
    const v = !!collapsed;
    for (const n of S.data.nodes) if (n.kind === 'module') n.collapsed = v;
  }

  D.data = Object.freeze({ recomputeMissingEdges, mergeArtifacts, normalizeNodes, setAllModulesCollapsed });
})();
