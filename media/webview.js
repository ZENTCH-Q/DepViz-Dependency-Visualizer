// media/webview.js

(function(){
  const VS = globalThis.vscode;
  const D = globalThis.DepViz || (globalThis.DepViz = {});

  const svg = document.getElementById('canvas');
  const wrapper = document.getElementById('canvasWrapper');
  const themeToggle = document.getElementById('themeToggle');
  const btnArrange = document.getElementById('btnArrange');
  const btnClear = document.getElementById('btnClear');
  // Layout constants
  const MOD_PAD = 10, MOD_HEAD = 28, SLOT_H = 50, GAP = 8;
  const FUNC_H = 42, FUNC_W_DEFAULT = 180;
  const DETACH_PAD = 24;

  const S = (D.state = D.state || {});

  const state = S;
  // Ensure sane defaults without relying on any sample payload
  state.data = state.data || { nodes: [], edges: [] };
  state.pan = state.pan || { x: 0, y: 0 };
  state.zoom = (typeof state.zoom === 'number') ? state.zoom : 1;
  state.typeVisibility = state.typeVisibility || { import: true, call: true };
  state.moduleBoxes = state.moduleBoxes || new Map();

  // Restore theme and canvas state (don't stash full graph in VS state)
  let restoredFromState = false;
  try {
    const s = VS?.getState?.();
    const savedTheme = s?.theme;
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
      themeToggle.setAttribute('src', savedTheme === 'light'
        ? themeToggle.getAttribute('data-icon-light')
        : themeToggle.getAttribute('data-icon-dark'));
    }
    if (s?.pan) S.pan = s.pan;
    if (typeof s?.zoom === 'number') S.zoom = s.zoom;
    restoredFromState = !!(s && (s.pan || typeof s.zoom === 'number' || s.theme));
  } catch {}

  // Scene graph
  const root = createSvg('g', {id: 'root'});

  const gEdgesBack      = createSvg('g', {id:'edges-back'});
  const gModules        = createSvg('g', {id:'modules'});            // expanded modules live here
  const gEdgesFront     = createSvg('g', {id:'edges-front'});        // edges go here
  const gModulesAbove   = createSvg('g', {id:'modules-above'});      // collapsed modules go here (above edges)
  const gClassesDocked  = createSvg('g', {id:'classes-docked'});
  const gFuncsDocked    = createSvg('g', {id:'funcs-docked'});
  const gClassesFree    = createSvg('g', {id:'classes-free'});
  const gFuncsFree      = createSvg('g', {id:'funcs-free'});
  // Order: modules/classes -> edges -> collapsed modules (above edges) -> functions
  root.appendChild(gEdgesBack);      // behind
  root.appendChild(gModules);
  root.appendChild(gClassesDocked);
  root.appendChild(gClassesFree);
  root.appendChild(gEdgesFront);     // above containers
  root.appendChild(gModulesAbove);
  root.appendChild(gFuncsDocked);
  root.appendChild(gFuncsFree);
  svg.appendChild(root);

  // Indexes
  let nodeMap = new Map();
  let edgesByFrom = new Map();
  let edgesByTo = new Map();

  // Init extracted UI (menus + search)
  D.ui && D.ui.initUI && D.ui.initUI(svg, wrapper, VS);
  // Restore original canvas menu handler (delegates to UI layer)
  wrapper.addEventListener('contextmenu', (e)=>{
    if (e.target !== wrapper && e.target !== svg) return;
    D.ui && D.ui.showCanvasMenu && D.ui.showCanvasMenu(e, VS);
  });

  function doDelete(t){
    if (t.kind==='edge' && t.el?._depvizEdge) {
      const e = t.el._depvizEdge;
      state.data.edges = state.data.edges.filter(x => x!==e);
      schedule(); return;
    }
    if (t.kind==='func') {
      const id = t.id;
      state.data.nodes = state.data.nodes.filter(n => n.id!==id);
      state.data.edges = state.data.edges.filter(e => e.from!==id && e.to!==id);
      schedule(); return;
    }
    if (t.kind==='module') {
      const id = t.id;
      const mod = state.data.nodes.find(n=>n.id===id);
      const kill = new Set([id, ...state.data.nodes.filter(n=>n.parent===id).map(n=>n.id)]);
      state.data.nodes = state.data.nodes.filter(n => !kill.has(n.id));
      state.data.edges = state.data.edges.filter(e => !kill.has(e.from) && !kill.has(e.to));
      try { if (VS && mod && mod.fsPath) { VS.postMessage({ type: 'evictFingerprint', fsPath: mod.fsPath }); } } catch {}
      schedule(); return;
    }
  }

  // --- Legend with real stroke styles ---
  const legend = document.getElementById('legend');
  legend.innerHTML = [legendItem('call')].join('');
  legend.querySelectorAll('.legend-item').forEach(el=>{
    el.addEventListener('click', ()=>{
      const t = el.getAttribute('data-type');
      state.typeVisibility[t] = !state.typeVisibility[t];
      el.classList.toggle('off', !state.typeVisibility[t]);
      applyTypeVisibility();
    });
  });
  function legendItem(type){
    const withCenterArrow = (type === 'call'); // only calls get arrows
    // Straight line; for "call" we draw a small centered triangle matching real mid-arrow styling
    const arrow = withCenterArrow
      ? `<path class="edge-arrow ${type}" d="M -6 -3 L 0 0 L -6 3 z" transform="translate(19,5)"></path>`
      : '';
    return `
      <div class="legend-item" data-type="${type}" title="toggle ${type}">
        <svg class="legend-svg" viewBox="0 0 38 10" xmlns="http://www.w3.org/2000/svg">
          <path class="legend-path ${type}" d="M2 5 L36 5"></path>
          ${arrow}
        </svg>
        <span>${type}</span>
      </div>`;
  }

  // Palette (for varying initial edge opacity)
  let colorIdx = 0;
  const palette = buildPalette(48);
  function nextEdgeOpacity() { const c = palette[colorIdx++ % palette.length]; return c.opacity; }

  // --- Scheduler / transforms ---
  function schedule(){ if (S.needsFrame) return; S.needsFrame = true; requestAnimationFrame(()=>{ S.needsFrame=false; try { renderAll(); } catch(e){ console.error(e); } try { VS?.setState?.({ theme: document.documentElement.getAttribute('data-theme')||'dark', pan:S.pan, zoom:S.zoom }); } catch{} try { _postDirty && _postDirty(); } catch{} }); }
  D.schedule = schedule;

  // --- Impact Slice (blast-radius) ----------------------------------------
  function computeSlice(startId, dir='out'){ // dir: 'out' | 'in'
    const vis = DepViz.state.typeVisibility || {};
    const NM = globalThis.DepViz?.indices?.nodeMap || new Map();
    const startNode = NM.get(startId);
    // Seed: classes have no edges → start from their methods; keep class in set for highlight.
    const seed = new Set([startId]);
    if (startNode && startNode.kind === 'class') {
      for (const [id, n] of NM) if (n.kind==='func' && n.parent===startId) seed.add(id);
    }
    const nexts = (e)=> (e.type==='import' && !vis.import) || (e.type==='call' && !vis.call) ? [] : [e.to];
    const preds = (e)=> (e.type==='import' && !vis.import) || (e.type==='call' && !vis.call) ? [] : [e.from];
    const q=[...seed], seen=new Set(seed), edgeSet=new Set();
    const t0 = performance.now();
    while (q.length){
      if ((performance.now() - t0) > 50) break; // kill-metric guard
      const v=q.shift();
      const arr = (dir==='out' ? (edgesByFrom.get(v)||[]) : (edgesByTo.get(v)||[]))
                    .filter(el => !el._isArrow);
      for (const el of arr){
        const e=el._depvizEdge; if (!e) continue;
        const nbrs = dir==='out' ? nexts(e) : preds(e);
        for (const w of nbrs){
          if (!NM.has(w)) continue;
          const key = (globalThis.DepViz?.data?.edgeKey)
            ? globalThis.DepViz.data.edgeKey(e)
            : `${e.from}->${e.to}:${e.type}`;
          edgeSet.add(key);
          if (!seen.has(w)){ seen.add(w); q.push(w); }
        }
      }
    }
    includeAncestors(seen, NM);
    return { nodes: seen, edges: edgeSet };
  }

  function includeAncestors(set, NM){
    // func → (class?) → module ; class → module
    const add = (id)=>{ if (id && NM.has(id)) set.add(id); };
    for (const id of Array.from(set)){
      const n = NM.get(id); if (!n) continue;
      if (n.kind === 'func'){
        const parent = NM.get(n.parent);
        if (parent && parent.kind === 'class'){
          add(parent.id);
          const mod = NM.get(parent.parent); if (mod && mod.kind==='module') add(mod.id);
        } else {
          const mod = NM.get(n.parent); if (mod && mod.kind==='module') add(mod.id);
        }
      } else if (n.kind === 'class'){
        const mod = NM.get(n.parent); if (mod && mod.kind==='module') add(mod.id);
      }
    }
  }

  function applySliceOverlay(slice){
    const on = !!(slice && slice.nodes && slice.nodes.size);
    DepViz.state.slice = on ? slice : null;
    // nodes
    for (const g of svg.querySelectorAll('g.func-group, g.module-group, g.class-group, g[data-id]')){
      const id = g.getAttribute('data-id');
      const hit = on && slice.nodes.has(id);
      g.classList.toggle('node-transparent', on && !hit);
      g.classList.toggle('node-related', !!hit);
    }
    // edges
    const show = new Set(slice?.edges||[]);
    for (const p of svg.querySelectorAll('.edge')){
      const e = p._depvizEdge;
      const key = e ? ((globalThis.DepViz?.data?.edgeKey) ? globalThis.DepViz.data.edgeKey(e) : `${e.from}->${e.to}:${e.type}`) : '';
      const hit = on && show.has(key);
      p.classList.toggle('transparent', on && !hit);
      if (p._arrowEl) p._arrowEl.classList.toggle('transparent', on && !hit);
    }
  }

  function postImpactSummary(s, dir){
    try{
      const ids=[...s.nodes];
      const nodes = ids.map(id=> (globalThis.DepViz?.indices?.nodeMap?.get(id))).filter(Boolean);
      const mods = new Map(nodes.filter(n=>n.kind==='module').map(m=>[m.fsPath||m.label,m]));
      const funcs= nodes.filter(n=>n.kind==='func').length;
      const clss = nodes.filter(n=>n.kind==='class').length;
      VS && VS.postMessage({
        type:'impactSummary',
        payload:{ dir, files:[...mods.keys()], counts:{ modules:mods.size, classes:clss, funcs, edges:(s.edges?.size||0) } }
      });
    } catch {}
  }

  function updateTransform() {
    root.setAttribute('transform', `translate(${state.pan.x}, ${state.pan.y}) scale(${state.zoom})`);
    try {
      const z = state.zoom || 1;
      const a = Math.max(0.015, Math.min(0.06, 0.06 / z)); // 0.06 @1x → ~0.02 @3x
      document.documentElement.style.setProperty('--grid-a', a.toFixed(3));
      document.documentElement.style.setProperty('--grid-b', (a * 0.5).toFixed(3));
    } catch {}
  }
  function centerOnWorld(wx, wy){
    const rect = svg.getBoundingClientRect();
    state.pan.x = rect.width/2 - wx * state.zoom;
    state.pan.y = rect.height/2 - wy * state.zoom;
    updateTransform();
  }
  function centerOnNode(n){
    try {
      if (!n) return;
      if (n.kind === 'module' || n.kind === 'class'){
        const box = state.moduleBoxes.get(n.id) || { x: n.x||0, y: n.y||0, w: 220, h: 120 };
        centerOnWorld(box.x + box.w/2, box.y + box.h/2);
        return;
      }
      if (n.kind === 'func'){
        const tl = DepViz.geom.absTopLeftOf(n, n._w || FUNC_W_DEFAULT);
        centerOnWorld(tl.x + (n._w||FUNC_W_DEFAULT)/2, tl.y + FUNC_H/2);
        return;
      }
    } catch {}
  }
  function clientToWorld(e){
    const rect = svg.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    return { x: (cx - state.pan.x) / state.zoom, y: (cy - state.pan.y) / state.zoom };
  }

  // --- Zoom ---
  wrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    const prev = state.zoom;
    const next = Math.max(0.2, Math.min(3, prev * factor));
    const rect = svg.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const wx = (cx - state.pan.x) / prev, wy = (cy - state.pan.y) / prev;
    state.zoom = next;
    state.pan.x = cx - wx * next; state.pan.y = cy - wy * next;
    updateTransform();
  }, { passive: false });

  // --- Pan ---
  let panning=false, panOrigin={x:0,y:0};
  wrapper.addEventListener('mousedown', (e)=>{
    if (e.target === wrapper || e.target === svg) {
      panning = true; panOrigin = {x: e.clientX - state.pan.x, y: e.clientY - state.pan.y};
      wrapper.style.cursor = 'grabbing';
    }
  });
  const onPanMove = (e)=>{ if (!panning) return; state.pan.x = e.clientX - panOrigin.x; state.pan.y = e.clientY - panOrigin.y; updateTransform(); };
  const onPanUp = ()=>{ panning=false; wrapper.style.cursor='default'; };
  window.addEventListener('mousemove', onPanMove);
  window.addEventListener('mouseup', onPanUp);

  // Track cursor in world space
  wrapper.addEventListener('mousemove', (e)=>{
    const rect = svg.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const wx = (cx - state.pan.x) / state.zoom;
    const wy = (cy - state.pan.y) / state.zoom;
    state.lastCursorWorld = { x: wx, y: wy };
  });

  // --- Theme toggle ---
  function smoothThemeSwap(next){
    // Respect reduced motion
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.documentElement.setAttribute('data-theme', next);
      return;
    }
    // Snapshot current bg to fade from (wrapper to cover grid area)
    const wrap = document.getElementById('canvasWrapper');
    const currentBg = getComputedStyle(wrap || document.body).backgroundColor || '#0e1116';
    const overlay = document.createElement('div');
    overlay.className = 'theme-fade';
    overlay.style.background = currentBg;
    document.body.appendChild(overlay);
    document.documentElement.setAttribute('data-theme', next);
    requestAnimationFrame(()=>{ overlay.style.opacity = '0'; });
    overlay.addEventListener('transitionend', ()=> overlay.remove(), { once: true });
  }

  themeToggle.addEventListener('click', ()=>{
    const dark = themeToggle.getAttribute('data-icon-dark');
    const light = themeToggle.getAttribute('data-icon-light');
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const next = isDark ? 'light' : 'dark';
    smoothThemeSwap(next);
    themeToggle.setAttribute('src', next === 'light' ? light : dark);
    try { VS?.setState?.({ theme: next }); } catch {}
  });

  // Toolbar
  btnArrange?.addEventListener('click', ()=>{ DepViz.arrange?.autoArrangeLikeImport?.(); schedule(); });
  btnClear?.addEventListener('click', ()=>{ state.data = { nodes: [], edges: [] }; DepViz.data?.normalizeNodes?.(); schedule(); VS && VS.postMessage({ type: 'clearCanvas' }); });

  // Export/Import moved to canvas context menu

  // Hotkeys
  window.addEventListener('keydown', (e)=>{
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase()==='a'){ e.preventDefault(); DepViz.arrange?.autoArrangeLikeImport?.(); schedule(); }
  });
  // Make Escape actually useful: close search else clear slice (only if showing)
  window.addEventListener('keydown', (e)=>{
    if (e.key === 'Escape') {
      try {
        // if search is open, hide it; else clear impact slice
        if (document.getElementById('searchPopup')?.style.display === 'flex') {
          D.ui && D.ui.hideSearchBar && D.ui.hideSearchBar();
        } else {
          if (globalThis.DepViz?.state?.slice) {
            applySliceOverlay(null);
            schedule();
          }
        }
      } catch {}
    }
  });
  window.addEventListener('keydown', (e)=>{
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase()==='s') {
      e.preventDefault();
      if (globalThis.DepViz?.state?.slice) { applySliceOverlay(null); schedule(); }
    }
  });


  function hasLostMethods(clsId){
    return (state.data.nodes||[]).some(n => n.kind==='func' && n.parent===clsId && !n.docked);
  }
  function hasLostChildrenOfModule(modId){
    // lost module-level funcs
    if ((state.data.nodes||[]).some(n => n.kind==='func' && n.parent===modId && !n.docked)) return true;
    // undocked classes that belong to this module
    if ((state.data.nodes||[]).some(n => n.kind==='class' && n.parent===modId && !n.docked)) return true;
    // classes with lost methods
    return (state.data.nodes||[]).some(n => n.kind==='class' && n.parent===modId && hasLostMethods(n.id));
  }

  const _postDirty = (D.stateApi && D.stateApi.debounceDirty) ? D.stateApi.debounceDirty(VS) : null;
  const pushHistory = (label)=> D.stateApi && D.stateApi.pushHistory && D.stateApi.pushHistory(VS,label);
  const applySnapshot = (snap)=> D.stateApi && D.stateApi.applySnapshot && D.stateApi.applySnapshot(snap);
 function simpleHash(s){
   let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
   return (h>>>0).toString(16);
 }

  window.addEventListener('keydown', (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
      e.preventDefault();
      const snap = D.stateApi.snapshot ? D.stateApi.snapshot() : { version:1, pan:S.pan, zoom:S.zoom, typeVisibility:S.typeVisibility, data:S.data };
      VS && VS.postMessage({ type:'saveSnapshot', payload:snap });
    }
  });
  window.addEventListener('keydown', (e)=>{
    const stepPan = 40, stepZoom = 0.1;
    if (['+', '='].includes(e.key)) { state.zoom = Math.min(3, state.zoom + stepZoom); updateTransform(); }
    if (e.key === '-') { state.zoom = Math.max(0.2, state.zoom - stepZoom); updateTransform(); }
    if (e.key === 'ArrowLeft')  { state.pan.x += stepPan; updateTransform(); }
    if (e.key === 'ArrowRight') { state.pan.x -= stepPan; updateTransform(); }
    if (e.key === 'ArrowUp')    { state.pan.y += stepPan; updateTransform(); }
    if (e.key === 'ArrowDown')  { state.pan.y -= stepPan; updateTransform(); }
  });
 function doUndo(){
   try {
     if (state._histIndex <= 0) return;
     state._histIndex--;
     const snap = state._hist[state._histIndex];
     applySnapshot(snap);
     VS && VS.postMessage({ type:'edit', payload: snap, label:'Undo' });
   } catch {}
 }
 function doRedo(){
   try {
     if (state._histIndex >= state._hist.length - 1) return;
     state._histIndex++;
     const snap = state._hist[state._histIndex];
     applySnapshot(snap);
     VS && VS.postMessage({ type:'edit', payload: snap, label:'Redo' });
   } catch {}
 }
  window.addEventListener('keydown', (e)=>{
    const mod=e.ctrlKey||e.metaKey; const k=e.key.toLowerCase(); if(!mod) return;
    if(k==='z'&&!e.shiftKey){ e.preventDefault(); D.stateApi && D.stateApi.undo && D.stateApi.undo(VS); D.schedule && D.schedule(); }
    else if(k==='y'||(k==='z'&&e.shiftKey)){ e.preventDefault(); D.stateApi && D.stateApi.redo && D.stateApi.redo(VS); D.schedule && D.schedule(); }
  });
  // --- Drag & Drop import ---
  ['dragenter','dragover'].forEach(ev => {
    const handler = e => { try { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } catch {} };
    wrapper.addEventListener(ev, handler);
    svg.addEventListener(ev, handler);
  });
  const onDrop = async (e) => {
    try { e.preventDefault(); e.stopPropagation(); } catch {}
    // Record world drop-point so new modules land where user drops
    try {
      const w = DepViz.svg?.clientToWorld?.(e);
      if (w && typeof w.x === 'number' && typeof w.y === 'number') {
        state.spawnOrigin = { x: w.x, y: w.y };
        state.spawnSeq = 0;
        state.lastSpawnAtMs = performance.now ? performance.now() : Date.now();
      }
    } catch {}
    const items = [];
    try {
      const uriList = (e.dataTransfer && e.dataTransfer.getData) ? (e.dataTransfer.getData('text/uri-list') || '') : '';
      if (uriList && uriList.trim()) {
        uriList.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(u => items.push(u));
      }
      const textPlain = (e.dataTransfer && e.dataTransfer.getData) ? (e.dataTransfer.getData('text/plain') || '') : '';
      if (textPlain && textPlain.trim()) {
        textPlain.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(u => items.push(u));
      }
      if (e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items.length) {
        const promises = [];
        for (const it of Array.from(e.dataTransfer.items)) {
          if (it.kind === 'string' && (it.type === 'text/uri-list' || it.type === 'text/plain')) {
            promises.push(new Promise(res => it.getAsString(s => res(s || ''))));
          }
        }
        const extra = await Promise.all(promises);
        for (const s of extra) if (s) s.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).forEach(u=>items.push(u));
      }
      if ((!items.length) && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        for (const f of e.dataTransfer.files) { try { if (f.path) items.push(f.path); } catch {} }
      }
    } catch {}
    if (items.length && VS) VS.postMessage({ type: 'droppedUris', items: Array.from(new Set(items)) });
  };
  wrapper.addEventListener('drop', onDrop);
  svg.addEventListener('drop', onDrop);

  // --- Load & messages ---
  try { S._wasEmptyBeforeImport = !(S.data && S.data.nodes && S.data.nodes.length); } catch {}
  try { schedule(); pushHistory('Initial'); } catch { schedule(); }

  if (VS) {
    window.addEventListener('message', (event) => {
      try {
        const msg = event.data;
        console.log('[DepViz] message:', msg?.type);
        if (msg.type === 'addArtifacts') {
          const p = msg.payload || {};
          if (!p.sourceId) {
            try {
              const first = (p.nodes && p.nodes.find(n => n.fsPath)) || null;
              if (first && first.fsPath) {
                // crude but stable: folder of first file
                p.sourceId = String(first.fsPath).replace(/[\\/][^\\/]+$/, '');
              }
            } catch {}
          }

          // If this batch is a full replacement for that source, remember it
          if (p.fullRescan && p.sourceId) {
            // Record so we can prime positions once per rescan
            S._lastFullRescanFor = p.sourceId;
          }

          // Pre-position incoming modules so they don't stack and appear near drop
          try { primeSpawnPositions(p); } catch {}

          // Merge but defer heavy recompute unless caller says this ends a batch
          DepViz.data?.mergeArtifacts?.(p);
          DepViz.data?.normalizeNodes?.();

          if (p.endOfBatch || !p.batchId) {
            // Edges after final batch only to avoid flicker / false-unresolved
            DepViz.data?.recomputeMissingEdges?.();
            // If this is the very first graph on an empty canvas OR a full rescan, auto-arrange
            try {
              const wasEmpty = (S._wasEmptyBeforeImport === true) || ((S._wasEmptyBeforeImport = false), false);
              const firstTime = wasEmpty || (p.fullRescan && p.sourceId === S._lastFullRescanFor);
              if (firstTime) DepViz.arrange?.autoArrangeLikeImport?.(S.spawnOrigin);
            } catch {}
          }
          schedule();
          pushHistory('Import artifacts');
        }
        if (msg.type === 'autoArrange') { DepViz.arrange?.autoArrangeLikeImport?.(); schedule(); }
        if (msg.type === 'clear') { state.data = { nodes: [], edges: [] }; schedule(); }
        if (msg.type === 'loadSnapshot') {
          const snap = msg.payload || {};
          const data = snap.data || snap;
          applySnapshot({ ...snap, data });
          schedule();
          D.stateApi && D.stateApi.pushHistory && D.stateApi.pushHistory(VS, 'Load snapshot');
          return;
        }
      } catch(e){ console.error('DepViz message error:', e); }
    });
  }

  // ---------- Render ----------
  function renderAll() {
    try {
      // rebuild indexes
      nodeMap = new Map(state.data.nodes.map(n => [n.id, n]));
      edgesByFrom = new Map(); edgesByTo = new Map();
      // publish indices for other modules
      try { globalThis.DepViz.indices = { nodeMap, edgesByFrom, edgesByTo }; } catch {}
      gModules.innerHTML = '';
      gModulesAbove.innerHTML = '';
      gEdgesBack.innerHTML = ''; gEdgesFront.innerHTML = '';
      gClassesDocked.innerHTML = ''; gFuncsDocked.innerHTML = '';
      gClassesFree.innerHTML = ''; gFuncsFree.innerHTML = '';
      state.moduleBoxes.clear();

      // group children by parent (functions and classes)
      const childrenByParent = new Map();
      for (const n of state.data.nodes) if ((n.kind==='func' || n.kind==='class') && n.docked && n.parent) {
        if (!childrenByParent.has(n.parent)) childrenByParent.set(n.parent, []);
        childrenByParent.get(n.parent).push(n);
      }

      // modules
      const meas = textMeasurer();
      for (const m of state.data.nodes) {
        if (m.kind !== 'module') continue;
        const kids = childrenByParent.get(m.id) || [];
        const classKids = kids.filter(k=>k.kind==='class');
        const funcKids = kids.filter(k=>k.kind==='func');

        const titleW = meas(m.label, 12, true) + MOD_PAD*2;
        // Measure immediate children and also methods inside classes so module fits the widest label
        let childW = 160;
        for (const ch of kids) childW = Math.max(childW, meas(ch.label, 12, false) + 20);
        for (const c of classKids) {
          const methods = (childrenByParent.get(c.id)||[]).filter(n=>n.kind==='func');
          for (const f of methods) childW = Math.max(childW, meas(f.label, 12, false) + 20);
        }
        const MOD_W = Math.max(220, titleW, childW + MOD_PAD*2);
        // compute full open height: classes (with methods) + module-level funcs
        let classesH = 0;
        for (const c of classKids){ const methods = (childrenByParent.get(c.id)||[]).filter(n=>n.kind==='func'); classesH += (MOD_HEAD + MOD_PAD + (methods.length*(SLOT_H+GAP)) + MOD_PAD); }
        const modH_open = MOD_HEAD + MOD_PAD + (funcKids.length * (SLOT_H + GAP)) + classesH + MOD_PAD;
        const modH_closed = MOD_HEAD + MOD_PAD + MOD_PAD;
        const modH = m.collapsed ? modH_closed : modH_open;

        const gx = (m.x ?? 0), gy = (m.y ?? 0);
        const g = createSvg('g', {transform:`translate(${gx}, ${gy})`, 'data-id': m.id});
        g.classList.add('module-group');
        if (m.ghost) g.classList.add('ghost');

        const rect = createSvg('rect', {width: MOD_W, height: modH, class:'module'});
        g.appendChild(rect);
        g.appendChild(createText(MOD_PAD, 16, 'module-title', m.label));
        // highlight search matches on module title
        maybeAddSearchMarks(g, m, MOD_PAD, 6, m.label, true);
        g.appendChild(createText(MOD_PAD, 26, 'module-badge', 'module'));
        try {
          const lsp = (m && m.lspStatus) ? m.lspStatus : 'ok'; // 'ok' | 'partial' | 'nolsp'
          const color = lsp === 'ok' ? '#22c55e' : (lsp === 'partial' ? '#f59e0b' : '#ef4444');
          const dot = createSvg('circle', { cx: MOD_W - 10, cy: 10, r: 5, class: 'status-dot' });
          dot.setAttribute('fill', color);
          g.appendChild(dot);
        } catch {}
        // Collapsed modules must render above edges; expanded modules below
        (m.collapsed ? gModulesAbove : gModules).appendChild(g);
        // docked layer for module-level functions; appended after layout
        const gm = createSvg('g', {'data-owner': m.id, transform:`translate(${gx}, ${gy})`});

        // Compute flow layout for classes and module funcs interleaved by desired y
        let modHeightActual = MOD_HEAD + MOD_PAD + MOD_PAD;
        if (!m.collapsed) {
          const innerW = MOD_W - MOD_PAD*2;
          const items = [];
          for (const c of kids) {
            if (c.kind === 'class') {
              const methods = (childrenByParent.get(c.id)||[]).filter(n=>n.kind==='func');
              const classH = MOD_HEAD + MOD_PAD + (methods.length * (SLOT_H + GAP)) + MOD_PAD;
              const want = (typeof c.dy === 'number') ? c.dy : Infinity;
              items.push({ type:'class', node:c, h: classH, want });
            } else if (c.kind === 'func') {
              const want = (typeof c.dy === 'number') ? c.dy : Infinity;
              items.push({ type:'func', node:c, h: SLOT_H, want });
            }
          }
          items.sort((a,b)=> (a.want - b.want));
          let yCursor = MOD_HEAD + MOD_PAD;
          for (const it of items) {
            if (it.type === 'class') {
              const c = it.node;
              // Keep method order stable by previously stored dy when present
              let methods = (childrenByParent.get(c.id)||[]).filter(n=>n.kind==='func');
              const score = (v)=> (typeof v === 'number') ? v : Infinity;
              methods = methods.slice().sort((a,b)=> score(a.dy) - score(b.dy));
              const absX = gx + MOD_PAD, absY = gy + yCursor;
              c.dx = MOD_PAD; c.dy = yCursor;
              const group = createClassGroup(c, absX, absY, innerW, methods);
              gClassesDocked.appendChild(group.g);
              gFuncsDocked.appendChild(group.gm);
              state.moduleBoxes.set(c.id, { x: absX, y: absY, w: innerW, h: it.h });
            } else {
              const f = it.node;
              const funcW = innerW;
              const dx = MOD_PAD;
              const dy = yCursor;
              f._w = funcW; f.dx = dx; f.dy = dy;
              const group = createFuncGroup(f, funcW, dx, dy, true);
              gm.appendChild(group);
            }
            yCursor += it.h + GAP;
          }
          modHeightActual = yCursor + MOD_PAD;
        }
        state.moduleBoxes.set(m.id, { x: gx, y: gy, w: MOD_W, h: modHeightActual });
        try { rect.setAttribute('height', String(modHeightActual)); } catch {}
        gFuncsDocked.appendChild(gm);

        try { globalThis.DepViz?.interact?.enableModuleDrag && globalThis.DepViz.interact.enableModuleDrag(g, rect, m, gm); } catch {}

        g.addEventListener('click', (e)=>{ e.stopPropagation(); /* no highlight */ });

        g.addEventListener('dblclick', (e)=>{
          e.stopPropagation();
          m.collapsed = !m.collapsed;
          schedule();
        });
        g.addEventListener('contextmenu', (e)=>{
          const items = [
            { id:'toggle', label: m.collapsed ? 'Expand card' : 'Collapse card', run: ()=>{ m.collapsed = !m.collapsed; schedule(); } },
            { id:'focus_card', label:'Focus this card', run: ()=>{ try { state.focusModuleId = m.id; state.focusId = null; applyTypeVisibility(); centerOnNode(m); schedule(); } catch{} } },
            { id:'open_file', label:'Open File', run: ()=>{ try { if (VS && m.fsPath){ VS.postMessage({ type:'openAt', fsPath: m.fsPath, line:0, col:0, view:'beside' }); } } catch{} } },
            { id:'slice_out', label:'Impact slice (outbound)', run: ()=>{ const s=computeSlice(m.id,'out'); applySliceOverlay(s); postImpactSummary(s,'out'); } },
            { id:'slice_in',  label:'Reverse slice (inbound)', run: ()=>{ const s=computeSlice(m.id,'in');  applySliceOverlay(s); postImpactSummary(s,'in'); } },
            { id:'delete', label:'Remove from canvas', run: ()=> doDelete({ kind:'module', id: m.id }) }
          ];
          if (hasLostChildrenOfModule(m.id)) {
            items.splice(2, 0, { id:'reassemble_mod', label:'Reassemble children', run: ()=> reassembleModuleById(m.id) });
          }
          D.ui?.showCtx?.(e, items);
        });
      }

      // free funcs/classes
      for (const n of state.data.nodes) {
        if ((n.kind !== 'func' && n.kind !== 'class') || n.docked) continue;
        if (n.kind === 'class') {
          const methods = (state.data.nodes||[]).filter(x=>x.kind==='func' && x.parent===n.id && x.docked);
          const titleW = meas(n.label, 12, true) + MOD_PAD*2;
          let childW = 160;
          for (const f of methods) childW = Math.max(childW, meas(f.label, 12, false) + 20);
          const width = Math.max(220, titleW, childW + MOD_PAD*2);
          const classH = MOD_HEAD + MOD_PAD + (methods.length * (SLOT_H + GAP)) + MOD_PAD;
          const gx = n.x ?? 0, gy = n.y ?? 0;
          const cg = createSvg('g', { transform: `translate(${gx}, ${gy})`, 'data-id': n.id, class: 'class-group' });
          const rect = createSvg('rect', { width: width, height: classH, class: 'class' });
          cg.appendChild(rect);
          cg.appendChild(createText(MOD_PAD, 16, 'module-title', n.label));
          cg.appendChild(createText(MOD_PAD, 26, 'module-badge', 'class'));
          maybeAddSearchMarks(cg, n, MOD_PAD, 6, n.label, true);
          state.moduleBoxes.set(n.id, { x: gx, y: gy, w: width, h: classH });
          // Render methods in a separate top-level group above edges
          const gmFree = createSvg('g', { 'data-owner': n.id, transform: `translate(${gx}, ${gy})` });
          let y2 = MOD_HEAD + MOD_PAD;
          for (const f of methods) {
            const funcW = width - MOD_PAD*2;
            const dx = MOD_PAD + (width - MOD_PAD*2 - funcW) / 2;
            const dy = y2; y2 += SLOT_H + GAP;
            f._w = funcW; f.dx = dx; f.dy = dy;
            const group = createFuncGroup(f, funcW, dx, dy, true);
            gmFree.appendChild(group);
          }
          try { globalThis.DepViz?.interact?.enableClassDrag && globalThis.DepViz.interact.enableClassDrag(cg, rect, n); } catch {}
          cg.addEventListener('contextmenu', (e)=>{
            const nameOnly = (n.label||'').replace(/^class\s+/,'').trim();
            const items = [
              { id:'reattach_parent', label:'Re-attach to module', run: ()=> reattachClassById(n.id) },
              { id:'goto', label:`Go to definition: ${nameOnly}` , run: ()=>{ try { if (VS && n.fsPath){ VS.postMessage({ type:'gotoDef', target: { file: n.fsPath, name: nameOnly }, view:'beside' }); } } catch{} } },
              { id:'slice_out', label:'Impact slice (outbound)', run: ()=>{ const s=computeSlice(n.id,'out'); applySliceOverlay(s); postImpactSummary(s,'out'); } },
              { id:'slice_in',  label:'Reverse slice (inbound)', run: ()=>{ const s=computeSlice(n.id,'in');  applySliceOverlay(s); postImpactSummary(s,'in'); } },
            ];
            if (hasLostMethods(n.id)) {
              items.splice(1, 0, { id:'reassemble_cls', label:'Reassemble children (methods)', run: ()=> reassembleClassById(n.id) });
            }
            D.ui?.showCtx?.(e, items);
          });
          gClassesFree.appendChild(cg);
          gFuncsFree.appendChild(gmFree);
          continue;
        }
        const funcW = Math.max(160, meas(n.label, 12, false) + 20);
        n._w = funcW;
        const group = createFuncGroup(n, funcW, n.x ?? 0, n.y ?? 0, false);
        gFuncsFree.appendChild(group);
      }

      // edges
      colorIdx = 0;
      for (const e of state.data.edges) {
        if (e.type === 'import') continue;
        const toMissing = !nodeMap.has(e.to) && e.type === 'import';
        const path = createSvg('path', { class: `edge ${e.type}${toMissing?' unresolved':''}` });
        path.style.opacity = nextEdgeOpacity();
        if (e.type === 'call') {
          const arrowEl = createSvg('path', {
            class: `edge-arrow ${e.type}`,
            d: 'M -6 -3 L 0 0 L -6 3 z'
          });
          gEdgesFront.appendChild(arrowEl);
          path._arrowEl = arrowEl;
          try { arrowEl.style.opacity = path.style.opacity; } catch {}
        }
        // Tentatively add to front, compute geometry, then possibly re-layer to back
        gEdgesFront.appendChild(path);
        DepViz.geom.indexEdgeEl(e, path);
        DepViz.geom.updateEdgePathFor(e, path);
        // Decide z-lane: if this edge visually crosses any expanded module card (not its endpoints),
        // render it behind modules so the card occludes the line.
        try {
          const bb = path.getBBox(); // world coords relative to root scale/translate
          if (edgeShouldGoBehindExpandedModules(e, { x: bb.x, y: bb.y, w: bb.width, h: bb.height })) {
            // Move both the path and its arrow (if any) to the back layer
            gEdgesBack.appendChild(path);
            if (path._arrowEl) gEdgesBack.appendChild(path._arrowEl);
          } else {
            // Keep in front layer; already appended
          }
        } catch {}
        wireEdgeHover(path);
        // disable click highlight on edges
        path.addEventListener('click', (ev)=>{ ev.stopPropagation(); /* no highlight */ });
        path.addEventListener('contextmenu', (e)=>{
          const items=[{id:'delete',label:'Remove from canvas',run:()=>doDelete({kind:'edge',el:path})}];
          D.ui?.showCtx?.(e, items);
        });
      }

      applyTypeVisibility();
      updateTransform();
      try { if (globalThis.DepViz?.state?.slice) applySliceOverlay(globalThis.DepViz.state.slice); } catch {}
    } catch (err){
      console.error('DepViz render error:', err);
    }
  }

  // Build SVG group for a function node
  function createFuncGroup(n, funcW, x, y, docked){
    const g = createSvg('g', { transform: `translate(${x}, ${y})`, 'data-id': n.id, class: 'func-group' });
    const rect = createSvg('rect', { width: funcW, height: FUNC_H, class: 'func' });
    g.appendChild(rect);
    g.appendChild(createText(10, 16, 'label', n.label || 'func'));
    // search highlight for function/class label
    maybeAddSearchMarks(g, n, 10, 4, n.label||'func', false);
    g.appendChild(createText(10, 28, 'badge', (n.kind==='class'?'class':'func')));
    // enable dragging for functions
    try { globalThis.DepViz?.interact?.enableFuncDrag && globalThis.DepViz.interact.enableFuncDrag(g, rect, n, funcW, docked); } catch {}
    g.addEventListener('contextmenu', (e)=>{
      const nameOnly = n.kind==='class' ? (n.label||'').replace(/^class\s+/,'').trim()
                                        : (n.label||'').replace(/^def\s+|\(.*$/g,'');
      const items = [
        { id:'goto', label:`Go to definition: ${nameOnly}` , run: ()=>{ try { if (VS && n.fsPath){ VS.postMessage({ type:'gotoDef', target: { file: n.fsPath, name: nameOnly }, view:'beside' }); } } catch{} } },
        { id:'peek', label:`Peek call sites: ${nameOnly}`, run: ()=>{ try { if (VS && n.fsPath && n.kind!=='class'){ VS.postMessage({ type:'peekRefs', target: { file: n.fsPath, name: nameOnly }, view:'beside' }); } } catch{} } },
        { id:'focus', label:`Focus function: ${nameOnly}`, run: ()=>{ try { state.focusId = n.id; state.focusModuleId = null; applyTypeVisibility(); centerOnNode(n); } catch{} } },
        { id:'slice_out', label:'Impact slice (outbound)', run: ()=>{ const s=computeSlice(n.id,'out'); applySliceOverlay(s); postImpactSummary(s,'out'); } },
        { id:'slice_in',  label:'Reverse slice (inbound)', run: ()=>{ const s=computeSlice(n.id,'in');  applySliceOverlay(s); postImpactSummary(s,'in'); } },
        { id:'delete', label:'Remove from canvas', run: ()=> doDelete({ kind:'func', id: n.id }) }
      ];
      if (!n.docked) {
        items.unshift({ id:'reattach_parent', label:'Re-attach to parent', run: ()=> reattachFuncById(n.id) });
      }
      D.ui?.showCtx?.(e, items);
    });
    // double-click disabled
    return g;
  }

  // --- Spawn placement -------------------------------------------------------
  function primeSpawnPositions(payload){
    const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
    if (!nodes.length) return;

    // Only act shortly after a drop; otherwise leave positions untouched
    const now = (performance && performance.now) ? performance.now() : Date.now();
    const fresh = (now - (state.lastSpawnAtMs || 0)) < 4000; // 4s window after a drop
    if (!fresh) return;

    const origin = state.spawnOrigin || state.lastCursorWorld || { x: 40, y: 40 };
    let seq = 0;
    const next = () => {
      const k = seq++;
      const row = Math.floor((-1 + Math.sqrt(1 + 8*k)) / 2);
      const used = row * (row + 1) / 2;
      const col = k - used;
      return { x: origin.x + (row - col) * 320, y: origin.y + col * 220 };
      // triangular fan-out around origin
    };

    for (const n of nodes) {
      if (n.kind === 'module' && (typeof n.x !== 'number' || typeof n.y !== 'number')) {
        const p = next();
        n.x = p.x; n.y = p.y;
      }
    }
  }
  function nextSpawnPos(origin, dx, dy){
    // simple grid fan-out near origin: 0,1,2,... → (0,0),(1,0),(0,1),(2,0),(1,1),(0,2),...
    const k = state.spawnSeq++ | 0;
    const row = Math.floor((-1 + Math.sqrt(1 + 8*k)) / 2); // triangular inverse
    const used = row * (row + 1) / 2;
    const col = k - used;
    const x = origin.x + (row - col) * dx;
    const y = origin.y + col * dy;
    return { x, y };
  }

  // Build SVG groups for a class container and its docked methods
  function createClassGroup(c, absX, absY, width, methods){
    const g = createSvg('g', { transform: `translate(${absX}, ${absY})`, 'data-id': c.id, class: 'class-group' });
    const classH = MOD_HEAD + MOD_PAD + (methods.length * (SLOT_H + GAP)) + MOD_PAD;
    const rect = createSvg('rect', { width: width, height: classH, class: 'class' });
    g.appendChild(rect);
    g.appendChild(createText(MOD_PAD, 16, 'module-title', c.label));
    g.appendChild(createText(MOD_PAD, 26, 'module-badge', 'class'));
    // highlight for search matches on class label
    maybeAddSearchMarks(g, c, MOD_PAD, 6, c.label, true);

    // methods container is positioned absolutely in world space for drag behavior
    const gm = createSvg('g', {'data-owner': c.id, transform:`translate(${absX}, ${absY})`});
    let yCursor = MOD_HEAD + MOD_PAD;
    for (const f of methods) {
      const funcW = width - MOD_PAD*2;
      const dx = MOD_PAD + (width - MOD_PAD*2 - funcW) / 2;
      const dy = yCursor;
      yCursor += SLOT_H + GAP;
      f._w = funcW;
      f.dx = dx;
      f.dy = dy;
      const group = createFuncGroup(f, funcW, dx, dy, true);
      gm.appendChild(group);
    }
    // enable dragging the class container (moves gm as well)
    try { globalThis.DepViz?.interact?.enableClassDrag && globalThis.DepViz.interact.enableClassDrag(g, rect, c); } catch {}
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const label = String(c.label || '');
      const nameOnly = label.replace(/^class\s+/, '').replace(/\s*[:(].*$/, '').trim();
      const items = [
        { id:'goto', label:`Go to definition: ${nameOnly}`, run: ()=>{ try { if (VS && c.fsPath){ VS.postMessage({ type:'gotoDef', target:{ file:c.fsPath, name:nameOnly }, view:'beside' }); } } catch{} } },
        { id:'slice_out', label:'Impact slice (outbound)', run: ()=>{ const s=computeSlice(c.id,'out'); applySliceOverlay(s); postImpactSummary(s,'out'); } },
        { id:'slice_in',  label:'Reverse slice (inbound)', run: ()=>{ const s=computeSlice(c.id,'in');  applySliceOverlay(s,'in'); postImpactSummary(s,'in'); } },
        { id:'slice_clear', label:'Clear impact slice', run: ()=> applySliceOverlay(null) }
      ];
      // Only show if this class actually has undocked methods
      if (hasLostMethods(c.id)) {
        items.splice(1, 0, { id:'reassemble_cls', label:'Reassemble children (methods)', run: ()=> reassembleClassById(c.id) });
      }
      D.ui?.showCtx?.(e, items);
    });
    return { g, gm };
  }

  // Adds a background mark highlighting the matched substring for the current search hit
  function maybeAddSearchMarks(group, node, xBase, yBase, labelText, bold){
    try {
      const q = (state.searchQuery||'').trim().toLowerCase();
      if (!q) return;
      const text = String(labelText||'');
      const hay = text.toLowerCase();
      if (!hay.includes(q)) return;
      const meas = textMeasurer();
      let idx = 0;
      while ((idx = hay.indexOf(q, idx)) !== -1){
        const px = xBase + meas(text.slice(0, idx), 12, !!bold);
        const pw = Math.max(8, meas(text.slice(idx, idx + q.length), 12, !!bold));
        const mark = createSvg('rect', { x: px-1, y: yBase, width: pw+2, height: 14, class: 'search-mark' });
        const firstText = group.querySelector('text');
        group.insertBefore(mark, firstText || group.firstChild);
        idx += Math.max(1, q.length);
      }
    } catch {}
  }

  // --- Interactions: drag ---
  // Local drag handlers removed; unified in DepViz.interact.*

  // --- Hover (gentle, no global dimming) ---
  function wireNodeHover(_group, _node){ /* hover highlighting disabled */ }

  // Edge hover: thicken only
  function wireEdgeHover(_path){ /* hover highlighting disabled */ }

  // --- Focus/selection features removed ---

  // --- Edge bookkeeping ---
  // moved to DepViz.geom

  // --- Geometry ---
  // moved to DepViz.geom

  // --- DOM helpers ---
  function allFuncGroups(){ return [...svg.querySelectorAll('g.func-group')]; }
  function allModuleGroups(){ return [...svg.querySelectorAll('g.module-group')]; }
  function allEdgeEls(){ return [...gEdgesBack.querySelectorAll('.edge'), ...gEdgesFront.querySelectorAll('.edge')]; }

  // Toggle visibility of edge types; on focus, hide only non-incident edges (keep cards visible)
  function applyTypeVisibility(){
    try {
      const vis = state.typeVisibility || {};
      const searching = !!(state.searchQuery && state.searchQuery.length);
      // Clear any prior node-dimming
      for (const g of allFuncGroups()) g.classList.remove('node-transparent');
      for (const m of allModuleGroups()) m.classList.remove('node-transparent');
      const eligible = [];
      for (const p of allEdgeEls()){
        const e = p._depvizEdge || {};
        const showType = !!vis[e.type];
        p.classList.toggle('transparent', !showType);
        if (p._arrowEl) p._arrowEl.classList.toggle('transparent', !showType);
        if (showType) eligible.push(p);
      }
      // Focus dimming only when not searching
      const focusId = state.focusId;
      const focusModuleId = state.focusModuleId;
      if (!searching && (focusId || focusModuleId)){
        // Build set of ids considered incident when module-focused
        const incidentIds = new Set();
        if (focusModuleId){
          incidentIds.add(focusModuleId);
          for (const n of (state.data.nodes||[])) if (n.parent===focusModuleId) incidentIds.add(n.id);
        }
        for (const p of eligible){
          const e = p._depvizEdge; if (!e) continue;
          const incident = focusId ? (e.from===focusId || e.to===focusId)
                                   : (incidentIds.has(e.from) || incidentIds.has(e.to));
          p.classList.toggle('transparent', !incident);
          // sync arrow transparency with its path
          if (p._arrowEl) p._arrowEl.classList.toggle('transparent', !incident);
        }
      }
    } catch (e) { console.warn('applyTypeVisibility error:', e); }
  }
  // moved to DepViz.geom

  // Auto-arrange and data operations moved to separate modules (see DepViz.arrange, DepViz.data)

  // --- Misc utils ---
  function textMeasurer(){ const c=document.createElement('canvas'); const ctx=c.getContext('2d'); return (t,s=12,b=false)=>{ ctx.font = `${b?'600 ':''}${s}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`; return Math.ceil(ctx.measureText(t||'').width); }; }
  function createSvg(tag, attrs){ const el=document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in (attrs||{})) el.setAttribute(k, attrs[k]); return el; }
  function createText(x,y,cls,txt){ const t=createSvg('text',{x,y,class:cls}); t.textContent=txt; return t; }

  // --- Edge-vs-module occlusion helpers ------------------------------------
  function bboxIntersects(a, b){
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function homeModuleId(nodeId){
    const n = nodeMap.get(nodeId);
    if (!n) return null;
    if (n.kind === 'module') return n.id;
    if (n.kind === 'class')  return n.parent || null;
    if (n.kind === 'func'){
      const p = nodeMap.get(n.parent);
      if (!p) return null;
      return (p.kind === 'class') ? (p.parent || null) : (p.kind === 'module' ? p.id : null);
    }
    return null;
  }

  function edgeShouldGoBehindExpandedModules(edge, edgeBBox){
    try {
      const fromHome = homeModuleId(edge.from);
      const toHome   = homeModuleId(edge.to);
      for (const [id, box] of state.moduleBoxes){
        const m = nodeMap.get(id);
        if (!m || m.kind !== 'module') continue;
        if (!!m.collapsed) continue;            // collapsed modules already sit above edges; skip here
        if (id === fromHome || id === toHome) continue; // don’t hide under the endpoints’ own modules
        // box is {x,y,w,h} in world coords; edgeBBox is also in world coords
        if (bboxIntersects(edgeBBox, box)) return true;
      }
    } catch {}
    return false;
  }

  function resolveCollisions(kind, node){
    // Only nudge free-floating functions; ignore modules and classes entirely
    try {
      const n = (node && typeof node === 'object') ? node : (globalThis.DepViz?.indices?.nodeMap?.get(node) || null);
      if (!n || n.kind !== 'func' || n.docked) return;
    } catch { return; }
    const MIN_OVERLAP = 20; // px threshold to ignore tiny overlaps
    const intersects = (a,b)=> a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
    const boxes = [];
    // Only free-floating funcs participate in collision checks
    for (const n2 of state.data.nodes) if (n2.kind==='func' && !n2.docked){
      const w = (n2._w || FUNC_W_DEFAULT);
      boxes.push({id:n2.id, x:n2.x||0, y:n2.y||0, w, h:FUNC_H});
    }
    const targetId = node.id || node;
    const target = boxes.find(b=>b.id === targetId);
    if (!target) return;
    let moved=false, guard=0;
    const margin = 4;
    while (guard++ < 50) {
      let hit = null;
      for (const b of boxes) {
        if (b.id===target.id) continue;
        if (!intersects(target,b)) continue;
        const overlapX = Math.min(target.x+target.w, b.x+b.w) - Math.max(target.x, b.x);
        const overlapY = Math.min(target.y+target.h, b.y+b.h) - Math.max(target.y, b.y);
        if (Math.min(overlapX, overlapY) >= MIN_OVERLAP) { hit = { b, overlapX, overlapY }; break; }
      }
      if (!hit) break;
      // minimal translation vector away from clash along least-overlap axis
      const txc = target.x + target.w/2, tyc = target.y + target.h/2;
      const cxc = hit.b.x + hit.b.w/2, cyc = hit.b.y + hit.b.h/2;
      if (hit.overlapX <= hit.overlapY) {
        // push horizontally
        if (txc < cxc) target.x -= (hit.overlapX + margin); else target.x += (hit.overlapX + margin);
      } else {
        // push vertically
        if (tyc < cyc) target.y -= (hit.overlapY + margin); else target.y += (hit.overlapY + margin);
      }
      moved = true;
    }
    if (moved){ node.x = target.x; node.y = target.y; }
  }
  // Peek call sites helper (shows callers list and dims others)
  function peekCallSites(node, ev){
    try {
      state.focusId = node.id;
      const callers = (state.data.edges||[])
        .filter(e=>e.to===node.id && e.type!=='import')
        .map(e=> (globalThis.DepViz?.indices?.nodeMap||nodeMap).get(e.from))
        .filter(Boolean);
      if (!callers.length) { applyTypeVisibility(); return; }
      const items = callers.slice(0,20).map(caller => ({ id: 'open_'+caller.id, label: (caller.label||caller.id), run: ()=>{
        try { if (VS && caller.fsPath){ const line=(caller.range&&caller.range.line)||0; const col=(caller.range&&caller.range.col)||0; VS.postMessage({ type:'openAt', fsPath: caller.fsPath, line, col, view:'beside' }); } } catch{}
      }}));
      D.ui?.showCtx?.(ev, items);
      applyTypeVisibility();
    } catch(e){ console.error('peekCallSites error', e); }
  }
  function buildPalette(n){
    const arr = [];
    for (let i=0;i<n;i++){
      const opacity = 0.9 - (i % 5) * 0.1;
      arr.push({ opacity: opacity.toFixed(2) });
    }
    return arr;
  }

  // ---------- Re-attach & Reassemble helpers ----------
  function reattachFuncById(id){
    const n = (state.data.nodes||[]).find(x=>x.id===id && x.kind==='func');
    if (!n) return;
    n.docked = true;
    // Clear free pos so renderer clamps inside parent
    delete n.x; delete n.y;
    // Let layout recompute ideal slots
    delete n.dx; delete n.dy;
    schedule();
  }
  function reattachClassById(id){
    const n = (state.data.nodes||[]).find(x=>x.id===id && x.kind==='class');
    if (!n) return;
    n.docked = true;
    delete n.x; delete n.y;
    delete n.dx; delete n.dy;
    // also re-dock its methods
    for (const f of (state.data.nodes||[]))
      if (f.kind==='func' && f.parent===n.id){ f.docked = true; delete f.x; delete f.y; delete f.dx; delete f.dy; }
    schedule();
  }
  function reassembleModuleById(modId){
    const m = (state.data.nodes||[]).find(x=>x.id===modId && x.kind==='module');
    if (!m) return;
    // Pull back direct funcs
    for (const f of (state.data.nodes||[])) {
      if (f.kind==='func'){
        const parentClass = f.parent ? (globalThis.DepViz?.indices?.nodeMap?.get(f.parent) || null) : null;
        const homeModuleId = parentClass && parentClass.kind==='class' ? parentClass.parent : f.parent;
        if (homeModuleId === modId){
          f.docked = true; delete f.x; delete f.y; delete f.dx; delete f.dy;
        }
      }
    }
    // Pull back classes and their methods
    for (const c of (state.data.nodes||[])) {
      if (c.kind==='class' && c.parent===modId){
        c.docked = true; delete c.x; delete c.y; delete c.dx; delete c.dy;
        for (const f of (state.data.nodes||[]))
          if (f.kind==='func' && f.parent===c.id){ f.docked = true; delete f.x; delete f.y; delete f.dx; delete f.dy; }
      }
    }
    // Expand card so user sees the result
    m.collapsed = false;
    schedule();
  }
  function reassembleClassById(clsId){
    // Pull all methods back inside this class and let layout do the rest
    for (const f of (state.data.nodes||[])) {
      if (f.kind==='func' && f.parent===clsId) {
        f.docked = true;
        delete f.x; delete f.y; delete f.dx; delete f.dy;
      }
    }
    schedule();
  }
  // --- Export helpers ---
  // Bottom-center search popup
  let searchEl = null, searchInput = null, searchPrevBtn = null, searchNextBtn = null, searchCountEl = null;
  function showSearchBar(){
    try {
      if (!searchEl){
        searchEl = document.createElement('div');
        searchEl.id = 'searchPopup';
        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'searchInput';
        input.placeholder = 'Search... (Enter/Shift+Enter to cycle, Esc to close)';
        searchEl.appendChild(input);
        // Controls: Prev / Counter / Next
        const controls = document.createElement('div');
        controls.id = 'searchControls';
        const btnPrev = document.createElement('button'); btnPrev.id = 'searchPrev'; btnPrev.textContent = 'Prev';
        const count = document.createElement('span'); count.id = 'searchCount'; count.textContent = '';
        const btnNext = document.createElement('button'); btnNext.id = 'searchNext'; btnNext.textContent = 'Next';
        controls.appendChild(btnPrev); controls.appendChild(count); controls.appendChild(btnNext);
        searchEl.appendChild(controls);
        document.body.appendChild(searchEl);
        searchInput = input; searchPrevBtn = btnPrev; searchNextBtn = btnNext; searchCountEl = count;
        searchInput.addEventListener('keydown', (e)=>{
          if (e.key === 'Enter') { e.preventDefault(); cycleSearch(e.shiftKey ? -1 : 1); }
          if (e.key === 'Escape') { hideSearchBar(); }
        });
        searchInput.addEventListener('input', ()=>{ try { applySearch(searchInput.value); } catch{} });
        btnPrev.addEventListener('click', ()=>{ try { cycleSearch(-1); } catch{} });
        btnNext.addEventListener('click', ()=>{ try { cycleSearch(1); } catch{} });
        searchInput.addEventListener('blur', ()=>{ setTimeout(()=>{ try { if (searchEl && !searchEl.contains(document.activeElement)) hideSearchBar(); } catch {} }, 80); });
      }
      searchEl.style.display = 'flex';
      searchInput.focus(); searchInput.select();
    } catch {}
  }
  function hideSearchBar(){
    try {
      if (searchEl) searchEl.style.display='none';
      // Clear search state so no highlights remain
      state.searchQuery = '';
      state.searchMatches = [];
      state.searchIndex = -1;
      updateSearchCounter();
      schedule();
    } catch {}
  }

  function applySearch(q){
    const query = String(q||'').trim().toLowerCase();
    state.searchQuery = query;
    state.searchMatches = computeSearchMatches(query);
    state.searchIndex = -1;
    updateSearchCounter();
    // Camera behavior: if exactly one match across labels, center on it; otherwise, stay put
    try {
      if (query && state.searchMatches.length === 1) {
        const { n, idx } = state.searchMatches[0];
        const meas = textMeasurer();
        let wx=0, wy=0;
        if (n.kind==='module'){
          const box = state.moduleBoxes.get(n.id) || { x: n.x||0, y: n.y||0, w:220, h:120 };
          const px = MOD_PAD + meas(String(n.label||'').slice(0, idx), 12, true);
          const pw = meas(String(n.label||'').slice(idx, idx+query.length), 12, true);
          wx = box.x + px + pw/2; wy = box.y + 12;
        } else {
          const tl = DepViz.geom.absTopLeftOf(n, n._w || FUNC_W_DEFAULT);
          const px = 10 + meas(String(n.label||'').slice(0, idx), 12, false);
          const pw = meas(String(n.label||'').slice(idx, idx+query.length), 12, false);
          wx = tl.x + px + pw/2; wy = tl.y + 12;
        }
        centerOnWorld(wx, wy);
        state.searchIndex = 0;
        updateSearchCounter();
      }
    } catch {}
    schedule();
  }

  function computeSearchMatches(query){
    const out = [];
    if (!query) return out;
    for (const n of (state.data.nodes||[])){
      const label = String(n.label||'');
      const hay = label.toLowerCase();
      let i = 0;
      while (true){
        const idx = hay.indexOf(query, i);
        if (idx < 0) break;
        out.push({ n, idx });
        i = idx + Math.max(1, query.length);
      }
    }
    return out;
  }

  function updateSearchCounter(){
    try {
      if (!searchCountEl) return;
      const total = state.searchMatches.length;
      const cur = state.searchIndex >= 0 && state.searchIndex < total ? (state.searchIndex + 1) : 0;
      searchCountEl.textContent = total ? `${cur}/${total}` : '';
    } catch {}
  }

  function cycleSearch(delta){
    try {
      const total = state.searchMatches.length;
      if (!total) return;
      let idx = state.searchIndex;
      idx = ((idx < 0 ? -1 : idx) + delta + total) % total;
      state.searchIndex = idx;
      const { n, idx: off } = state.searchMatches[idx];
      const meas = textMeasurer();
      const q = state.searchQuery || '';
      let wx=0, wy=0;
      if (n.kind==='module'){
        const box = state.moduleBoxes.get(n.id) || { x: n.x||0, y: n.y||0, w:220, h:120 };
        const px = MOD_PAD + meas(String(n.label||'').slice(0, off), 12, true);
        const pw = meas(String(n.label||'').slice(off, off+q.length), 12, true);
        wx = box.x + px + pw/2; wy = box.y + 12;
      } else {
        const tl = DepViz.geom.absTopLeftOf(n, n._w || FUNC_W_DEFAULT);
        const px = 10 + meas(String(n.label||'').slice(0, off), 12, false);
        const pw = meas(String(n.label||'').slice(off, off+q.length), 12, false);
        wx = tl.x + px + pw/2; wy = tl.y + 12;
      }
      centerOnWorld(wx, wy);
      updateSearchCounter();
      schedule();
    } catch {}
  }
  async function exportSvg(){
    try {
      const link = document.querySelector('link[href*="webview.css"]');
      let css = '';
      try { css = link ? await fetch(link.href).then(r=>r.text()) : ''; } catch {}
      if (!css) {
        css = `.edge{fill:none;stroke-width:2.2}.module{rx:10;ry:10}.func{rx:8;ry:8}.class{rx:8;ry:8}`;
      }
      const clone = svg.cloneNode(true);
      const styleEl = document.createElementNS('http://www.w3.org/2000/svg','style');
      styleEl.textContent = css;
      clone.insertBefore(styleEl, clone.firstChild);
      const ser = new XMLSerializer();
      const text = ser.serializeToString(clone);
      const base64 = btoa(unescape(encodeURIComponent(text)));
      VS && VS.postMessage({ type:'exportData', kind:'svg', base64, suggestedName: 'depviz.svg' });
    } catch(e){ console.error('exportSvg error', e); }
  }
  async function exportPng(){
    try {
      const ser = new XMLSerializer();
      const text = ser.serializeToString(svg);
      const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const rect = svg.getBoundingClientRect();
      const scale = Math.max(1, Math.min(4, (globalThis.devicePixelRatio||2)));
      const w = Math.max(1, Math.floor(rect.width*scale));
      const h = Math.max(1, Math.floor(rect.height*scale));
      await new Promise((res, rej)=>{ img.onload = ()=>res(null); img.onerror = rej; img.src = url; });
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'; ctx.fillRect(0,0,w,h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/png');
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      VS && VS.postMessage({ type:'exportData', kind:'png', base64, suggestedName: 'depviz.png' });
    } catch(e){ console.error('exportPng error', e); }
  }
  function exportJson(){
    try {
      const text = JSON.stringify(state.data, null, 2);
      const base64 = btoa(unescape(encodeURIComponent(text)));
      VS && VS.postMessage({ type:'exportData', kind:'json', base64, suggestedName: 'depviz.json' });
    } catch(e){ console.error('exportJson error', e); }
  }
  function exportSnapshotDv(){
    try {
      const snapshot = {
        version: 1,
        pan: state.pan,
        zoom: state.zoom,
        typeVisibility: state.typeVisibility,
        data: state.data
      };
      const text = JSON.stringify(snapshot, null, 2);
      const base64 = btoa(unescape(encodeURIComponent(text)));
      VS && VS.postMessage({ type:'exportData', kind:'dv', base64, suggestedName: 'graph.dv' });
    } catch(e){ console.error('exportSnapshotDv error', e); }
  }
  // Minimal API surface for easier maintenance/testing
  try {
    globalThis.DepViz = globalThis.DepViz || {};
    const existingUI = globalThis.DepViz.ui || {};
    Object.assign(globalThis.DepViz, {
      state,
      schedule,
      showSearchBar,
      hideSearchBar,
      centerOnNode,
      applyTypeVisibility,
      svg: { updateTransform, clientToWorld, groups: { root, gEdgesBack, gEdgesFront, gModules, gClassesDocked, gFuncsDocked, gClassesFree, gFuncsFree, svg, gDocked: gClassesDocked, gFreeFuncs: gFuncsFree } },
      util: { textMeasurer, createSvg, createText, resolveCollisions, exportPng, exportSvg, exportJson, exportSnapshotDv },
      consts: { MOD_PAD, MOD_HEAD, SLOT_H, GAP, FUNC_H, FUNC_W_DEFAULT, DETACH_PAD }
    });
    const origShowCtx = existingUI.showCtx;
    globalThis.DepViz.ui = Object.assign({}, existingUI, {
      applyTypeVisibility,
      showSearchBar: () => showSearchBar(),
      showSearchBar,
      hideSearchBar,
      showCtx: function(e, items){
        try {
          if (Array.isArray(items)) {
            const hasSlice = !!(globalThis.DepViz?.state?.slice);
            const hasFocus = !!(state.focusId || state.focusModuleId);
            if (hasSlice || hasFocus) {
              const resetItem = {
                id: 'reset_highlights',
                label: 'Reset highlights',
                run: () => {
                  try { if (globalThis.DepViz?.state?.slice) applySliceOverlay(null); } catch {}
                  if (state.focusId || state.focusModuleId) {
                    state.focusId = null;
                    state.focusModuleId = null;
                    applyTypeVisibility();
                  }
                  schedule();
                }
              };
              // Put it first so it's easy to find.
              items = [resetItem, ...items];
            }
          }
        } catch {}
        return origShowCtx ? origShowCtx(e, items) : undefined;
      }
    });
    window.addEventListener('depviz:show-search', ()=>{ try { showSearchBar(); } catch {} });
    window.addEventListener('depviz:hide-search', ()=>{ try { hideSearchBar(); } catch {} });
  } catch {}
})();

