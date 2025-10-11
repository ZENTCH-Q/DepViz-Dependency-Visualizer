// media/webview-ui.js
(function(){
  const D = globalThis.DepViz || (globalThis.DepViz = {});
  const S = D.state;

  let _ctx, _ctxSub;

  function initUI(svg, wrapper, vscode){
    // context menus
    _ctx = el('div','context-menu'); document.body.appendChild(_ctx);
    _ctxSub = el('div','context-menu context-sub'); document.body.appendChild(_ctxSub);
    window.addEventListener('click', ()=>{ _ctx.style.display='none'; _ctxSub.style.display='none'; });

  }

  function showCtx(e, items){
    e.preventDefault();
    _ctx.innerHTML = '';
    items.forEach(it=>{
      const b = document.createElement('button');
      b.textContent = it.label + (Array.isArray(it.items) ? ' ›' : '');
      if (Array.isArray(it.items)) {
        b.addEventListener('click', (ev)=>{
          ev.stopPropagation();
          showSubmenu(b, it.items);
        });
      } else {
        b.addEventListener('click', ()=>{ try { it.run && it.run(); } finally { _ctx.style.display='none'; _ctxSub.style.display='none'; } });
      }
      _ctx.appendChild(b);
    });
    _ctx.style.display='block'; _ctx.style.left=e.clientX+'px'; _ctx.style.top=e.clientY+'px';
  }

  function showSubmenu(anchorBtn, items){
    _ctxSub.innerHTML = '';
    items.forEach(it=>{
      const b = document.createElement('button');
      b.textContent = it.label;
      b.addEventListener('click', ()=>{ try { it.run && it.run(); } finally { _ctx.style.display='none'; _ctxSub.style.display='none'; } });
      _ctxSub.appendChild(b);
    });
    const r = anchorBtn.getBoundingClientRect();
    _ctxSub.style.display='block';
    _ctxSub.style.left = (r.right + 6) + 'px';
    _ctxSub.style.top  = r.top + 'px';
  }

  function showCanvasMenu(e, vscode){
    const mods = (S.data.nodes||[]).filter(n=>n.kind==='module');
    const allCollapsed = mods.length>0 && mods.every(m=>!!m.collapsed);
    const items = [
      { label: allCollapsed ? 'Expand all cards' : 'Collapse all cards', run: ()=>{ try { D.data.setAllModulesCollapsed && D.data.setAllModulesCollapsed(!allCollapsed); } finally { D.schedule && D.schedule(); } } },
      { label: 'Auto layout (Ctrl/Cmd+Shift+A)', run: ()=>{ D.arrange && D.arrange.autoArrangeLikeImport && D.arrange.autoArrangeLikeImport(); D.schedule && D.schedule(); } },
      { label: 'Clear', run: ()=>{ S.data={nodes:[],edges:[]}; D.data.normalizeNodes && D.data.normalizeNodes(); D.schedule && D.schedule(); vscode && vscode.postMessage({ type:'clearCanvas' }); } },
      { label: 'Export', items: [
          { label: 'PNG',     run: ()=>{ try { D.util?.exportPng && D.util.exportPng(); } catch {} } },
          { label: 'SVG',     run: ()=>{ try { D.util?.exportSvg && D.util.exportSvg(); } catch {} } },
          { label: 'Snapshot (.dv)', run: ()=>{ try { D.util?.exportSnapshotDv && D.util.exportSnapshotDv(); } catch {} } },
          { label: 'JSON',    run: ()=>{ try { D.util?.exportJson && D.util.exportJson(); } catch {} } },
        ] },
      { label: 'Import Artifacts (.json)', run: ()=> vscode && vscode.postMessage({ type:'requestImportJson' }) },
      { label: 'Load Snapshot (.dv)', run: ()=> vscode && vscode.postMessage({ type:'requestImportSnapshot' }) },
      { label: 'Search…', run: ()=> D.showSearchBar?.() || D.ui?.showSearchBar?.() }
    ];
    showCtx(e, items);
  }

  function el(tag, cls, attrs){
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    Object.entries(attrs||{}).forEach(([k,v])=> x.setAttribute(k, String(v)));
    return x;
  }

  D.ui = Object.freeze({ initUI, showCtx, showCanvasMenu });
})();
