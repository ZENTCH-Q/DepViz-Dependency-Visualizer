// media/webview-ui.js
(function(){
  const D = globalThis.DepViz || (globalThis.DepViz = {});
  const S = D.state;

  let _ctx, _ctxSub, _searchPopup, _searchInput;

  function initUI(svg, wrapper, vscode){
    // context menus
    _ctx = el('div','context-menu'); document.body.appendChild(_ctx);
    _ctxSub = el('div','context-menu context-sub'); document.body.appendChild(_ctxSub);
    window.addEventListener('click', ()=>{ _ctx.style.display='none'; _ctxSub.style.display='none'; });

    // search popup
    _searchPopup = el('div','', { id:'searchPopup' });
    _searchPopup.style.display = 'none';
    _searchInput = document.createElement('input');
    _searchInput.placeholder = 'Search functions/classes...';
    _searchInput.addEventListener('keydown', (e)=>{ if (e.key==='Enter') focusFunctionByName(_searchInput.value, vscode); });
    _searchPopup.appendChild(_searchInput);
    document.body.appendChild(_searchPopup);
  }

  function showCtx(e, items){
    e.preventDefault();
    _ctx.innerHTML = '';
    items.forEach(it=>{
      const b = document.createElement('button');
      b.textContent = it.label;
      b.addEventListener('click', ()=>{ try { it.run && it.run(); } finally { _ctx.style.display='none'; _ctxSub.style.display='none'; } });
      _ctx.appendChild(b);
    });
    _ctx.style.display='block'; _ctx.style.left=e.clientX+'px'; _ctx.style.top=e.clientY+'px';
  }

  function showCanvasMenu(e, vscode){
    const mods = (S.data.nodes||[]).filter(n=>n.kind==='module');
    const allCollapsed = mods.length>0 && mods.every(m=>!!m.collapsed);
    const items = [
      { label: allCollapsed ? 'Expand all cards' : 'Collapse all cards', run: ()=>{ try { D.data.setAllModulesCollapsed && D.data.setAllModulesCollapsed(!allCollapsed); } finally { D.schedule && D.schedule(); } } },
      { label: 'Auto layout (Ctrl/Cmd+Shift+A)', run: ()=>{ D.arrange && D.arrange.autoArrangeLikeImport && D.arrange.autoArrangeLikeImport(); D.schedule && D.schedule(); } },
      { label: 'Clear', run: ()=>{ S.data={nodes:[],edges:[]}; D.data.normalizeNodes && D.data.normalizeNodes(); D.schedule && D.schedule(); vscode && vscode.postMessage({ type:'clearCanvas' }); } },
      { label: 'Export → PNG', run: ()=> { try { D.util?.exportPng && D.util.exportPng(); } catch {} } },
      { label: 'Import Artifacts (.json)', run: ()=> vscode && vscode.postMessage({ type:'requestImportJson' }) },
      { label: 'Load Snapshot (.dv)', run: ()=> vscode && vscode.postMessage({ type:'requestImportSnapshot' }) },
      { label: 'Search function...', run: ()=> showSearchBar() }
    ];
    showCtx(e, items);
  }

  function showSearchBar(){
    _searchPopup.style.display = 'flex';
    _searchInput.focus();
  }
  function hideSearchBar(){
    _searchPopup.style.display = 'none';
  }

  function focusFunctionByName(q, vscode){
    const NM = D.indices?.nodeMap || new Map();
    const hay = (q||'').trim().toLowerCase();
    if (!hay) return;
    for (const [id,n] of NM){
      if ((n.label||'').toLowerCase().includes(hay)){
        try { D.centerOnNode && D.centerOnNode(n); } catch {}
        S.focusId = n.id; S.focusModuleId = null;
        D.applyTypeVisibility && D.applyTypeVisibility();
        D.schedule && D.schedule();
        hideSearchBar();
        return;
      }
    }
  }

  function el(tag, cls, attrs){
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    Object.entries(attrs||{}).forEach(([k,v])=> x.setAttribute(k, String(v)));
    return x;
  }

  D.ui = Object.freeze({ initUI, showCanvasMenu, showSearchBar, hideSearchBar, focusFunctionByName });
})();
