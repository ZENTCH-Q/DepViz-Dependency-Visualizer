// Interaction module: drag and collapse behavior
(function(){
  const D = globalThis.DepViz || (globalThis.DepViz = {});
  const S = D.state;
  const G = (D.svg && D.svg.groups) || {};
  const warn = (...args) => { try { console.warn('[DepViz]', ...args); } catch {} };

  function mtv(a,b){
    const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
    if (a.x>=bx2 || b.x>=ax2 || a.y>=by2 || b.y>=ay2) return null;
    const dx = Math.min(ax2-b.x, bx2-a.x);
    const dy = Math.min(ay2-b.y, by2-a.y);
    if (dx < dy) return (a.x + a.w/2) < (b.x + b.w/2) ? {x:-dx,y:0} : {x:dx,y:0};
    return (a.y + a.h/2) < (b.y + b.h/2) ? {x:0,y:-dy} : {x:0,y:dy};
  }
  function pushOutFromModules(nx, ny, w, h, allowedModuleIds){
    const a = { x:nx, y:ny, w, h };
    let guard = 0;
    while (guard++ < 24){
      let moved = false;
      for (const [id, box] of (S.moduleBoxes||[])){
        const n = D.indices?.nodeMap?.get(id);
        if (!n || n.kind!=='module') continue;     // only collide with modules
        if (allowedModuleIds && allowedModuleIds.has(id)) continue; // don't repel home module
        const sep = mtv(a, box); if (sep){ a.x+=sep.x; a.y+=sep.y; moved=true; }
      }
      if (!moved) break;
    }
    return { x:a.x, y:a.y };
  }

  function boxUnderPoint(x, y, kinds /* array of 'module' | 'class' */){
    let best = null, bestArea = Infinity;
    for (const [id, box] of (S.moduleBoxes || [])){
      if (!box) continue;
      const n = D.indices?.nodeMap?.get(id);
      if (!n) continue;
      if (kinds && kinds.length && !kinds.includes(n.kind)) continue;
      if (D.geom.within(box, x, y)) {
        const area = (box.w||0) * (box.h||0) || Infinity;
        if (area < bestArea) { best = { id, node: n, box }; bestArea = area; }
      }
    }
    return best;
  }

  function enableModuleDrag(g, rect, node, gmDocked){
    let dragging=false, grab={x:0,y:0}, rafId=null;

    function pushOut(nx,ny){
      const self = S.moduleBoxes.get(node.id);
      const w=(self?.w)||220, h=(self?.h)||120;
      const a={x:nx,y:ny,w,h};
      let guard=0;
      while (guard++<24){
        let moved=false;
        for (const [id,box] of S.moduleBoxes){
          if (id===node.id) continue;
          const other = D.indices?.nodeMap?.get(id);
          if (!other || other.kind!=='module') continue; // collide only with modules
          const sep = mtv(a, box);
          if (sep){ a.x+=sep.x; a.y+=sep.y; moved=true; }
        }
        if (!moved) break;
      }
      return {x:a.x,y:a.y};
    }
    const apply = (nx,ny)=>{
      // resolve module-vs-module overlaps
      const out = pushOut(nx,ny); nx = out.x; ny = out.y;
      const prevX = node.x || 0, prevY = node.y || 0;
      const dx = nx - prevX, dy = ny - prevY;
      node.x = nx; node.y = ny;
      g.setAttribute('transform', `translate(${nx}, ${ny})`);
      if (gmDocked) gmDocked.setAttribute('transform', `translate(${nx}, ${ny})`);
      const b = S.moduleBoxes.get(node.id);
      if (b) { b.x = nx; b.y = ny; }
      try {
        // Move class containers under this module by same delta
        for (const n of (S.data.nodes||[])){
          if (n.kind==='class' && n.parent===node.id) {
            const cb = S.moduleBoxes.get(n.id);
            if (cb) {
              cb.x += dx; cb.y += dy;
              try {
                // If this class group is not nested under the module's gm (older render path), move it live
                const cgEl = (G['gClassesDocked']||document).querySelector(`[data-id="${n.id}"]`);
                const cgOwner = cgEl && cgEl.parentElement ? cgEl.parentElement.getAttribute('data-owner') : '';
                if (cgEl && cgOwner !== node.id) cgEl.setAttribute('transform', `translate(${cb.x}, ${cb.y})`);
                // And the legacy methods group keyed by data-owner=classId
                const methodsEl = (G['gFuncsDocked']||document).querySelector(`[data-owner="${n.id}"]`);
                const methodsOwner = methodsEl && methodsEl.parentElement ? methodsEl.parentElement.getAttribute('data-owner') : '';
                if (methodsEl && methodsOwner !== node.id) methodsEl.setAttribute('transform', `translate(${cb.x}, ${cb.y})`);
              } catch (e) { warn('enableModuleDrag/move-children', e); }
            }
          }
        }
      } catch {}
      try { D.geom.updateEdgesForNode(node.id); } catch (e) { warn('enableModuleDrag/updateEdges self', e); }
      for (const f of (S.data.nodes||[])) {
        // Update edges for direct children funcs and nested class methods
        const parent = f.parent ? (D.indices?.nodeMap?.get(f.parent) || { id: f.parent, kind: '' }) : null;
        const isDirect = f.parent===node.id;
        const isNested = !!(parent && parent.kind==='class' && parent.parent===node.id);
        if (f.docked && (isDirect || isNested)) D.geom.updateEdgesForNode(f.id);
      }
    };
    const onMove = (e)=>{
      if (!dragging) return;
      const w = D.svg.clientToWorld(e);
      const nx = w.x - grab.x; const ny = w.y - grab.y;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(()=>apply(nx,ny));
    };
    const onUp = ()=>{
      if (!dragging) return;
      dragging=false; rect.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try { console.assert(S.moduleBoxes && S.moduleBoxes.has(node.id), 'DepViz: missing module box for', node.id); } catch (e) { warn('enableModuleDrag/assert', e); }
      try {
        D.geom.updateEdgesForNode(node.id);
        for (const f of (S.data.nodes||[])){
          const parent = f.parent ? (D.indices?.nodeMap?.get(f.parent) || { id: f.parent, kind: '' }) : null;
          const isDirect = f.parent===node.id;
          const isNested = !!(parent && parent.kind==='class' && parent.parent===node.id);
          if (f.docked && (isDirect || isNested)) { try { D.geom.updateEdgesForNode(f.id); } catch (e) { warn('enableModuleDrag/updateEdges child', e); } }
        }
      } catch (e) { warn('enableModuleDrag/onUp updateEdges', e); }
      D.schedule();
    };
    g.addEventListener('mousedown', (e)=>{
      if (e.button!==0) return;
      e.stopPropagation(); e.preventDefault();
      dragging=true; rect.classList.add('dragging');
      const w = D.svg.clientToWorld(e);
      grab = { x: w.x - (node.x ?? 0), y: w.y - (node.y ?? 0) };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }
  function overlapRect(a,b){
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x+a.w, b.x+b.w), y2 = Math.min(a.y+a.h, b.y+b.h);
    const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1);
    return { w, h, area: w*h };
  }
  function bestDockTarget(rect, kinds, pad = (D.consts && D.consts.DETACH_PAD) || 24){
    let best=null, score=0;
    for (const [id, box] of (S.moduleBoxes || [])){
      const n = D.indices?.nodeMap?.get(id); if (!n) continue;
      if (kinds && kinds.length && !kinds.includes(n.kind)) continue;
      const expanded = { x: box.x - pad, y: box.y - pad, w: (box.w||0) + pad*2, h: (box.h||0) + pad*2 };
      const o = overlapRect(rect, expanded);
      if (o.area > score) { best = { id, node:n, box }; score = o.area; }
    }
    return best;
  }

  function enableFuncDrag(g, rect, node, funcW, docked){
    let dragging=false, grab={x:0,y:0}, rafId=null;
    const apply = (nx,ny)=>{
      if (node.docked) {
        const m = S.moduleBoxes.get(node.parent);
        if (!D.geom.within(m, nx + 10, ny + 10, (D.consts && D.consts.DETACH_PAD) || 24)) {
          node.docked = false; node.x = nx; node.y = ny;
          // Functions undock into the free-funcs layer (fix: 'cg' was undefined)
          (G['gFuncsFree'] || document.body).appendChild(g);
        } else {
          const C = D.consts || {}; const MOD_PAD = C.MOD_PAD||10; const MOD_HEAD = C.MOD_HEAD||28; const FUNC_H = C.FUNC_H||42;
          let headPad = MOD_HEAD + MOD_PAD;
          try { const p = D.indices?.nodeMap?.get(node.parent); headPad = (p && p.kind==='class') ? (22 + MOD_PAD) : (MOD_HEAD + MOD_PAD); } catch {}
          const innerW = Math.max(0, (m.w||0) - MOD_PAD*2);
          const maxDx = MOD_PAD + Math.max(0, innerW - (funcW||0));
          const relX = Math.max(MOD_PAD, Math.min(maxDx, nx - m.x));
          const maxDy = Math.max(headPad, (m.h||0) - MOD_PAD - FUNC_H);
          const relY = Math.max(headPad, Math.min(maxDy, ny - m.y));
          node.dx = relX; node.dy = relY;
        }
      } else {
        // Free: repel from NON-home modules only (match module↔module rules)
        const C = D.consts || {}; const FUNC_H = C.FUNC_H || 42;
        const w = (node._w || funcW || 180), h = FUNC_H;
        const parentClass = node.parent ? (D.indices?.nodeMap?.get(node.parent) || null) : null;
        const homeModuleId = parentClass && parentClass.kind==='class' ? parentClass.parent : (node.parent || null);
        const allowed = new Set(); if (homeModuleId) allowed.add(homeModuleId);
        const out = pushOutFromModules(nx, ny, w, h, allowed);
        node.x = out.x; node.y = out.y;
      }
      if (node.docked && S.moduleBoxes && S.moduleBoxes.get(node.parent)) {
        g.setAttribute('transform', `translate(${node.dx||0}, ${node.dy||0})`);
      } else {
        g.setAttribute('transform', `translate(${node.x||nx}, ${node.y||ny})`);
      }
      try { D.geom.updateEdgesForNode(node.id); } catch (e) { warn('enableFuncDrag/updateEdges live', e); }
    };
    const onMove = (e)=>{
      if (!dragging) return;
      const w = D.svg.clientToWorld(e);
      const nx = w.x - grab.x; const ny = w.y - grab.y;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(()=>apply(nx,ny));
    };
    const onUp = ()=>{
      if (!dragging) return;
      dragging=false; rect.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!node.docked) {
        const C = D.consts || {}; const w = (node._w || funcW || 180), h = (C.FUNC_H || 42);
        const rect = { x: (node.x||0), y: (node.y||0), w, h };
        let hit = bestDockTarget(rect, ['class','module']) || bestDockTarget(rect, ['module']);
        let target = hit?.id || null;
        let tNode  = hit?.node || null;
 
        // Determine the function's rightful home (class or module)
        const parentClass = node.parent ? (D.indices?.nodeMap?.get(node.parent) || null) : null;
        const homeModuleId = parentClass && parentClass.kind==='class' ? parentClass.parent : (node.parent || null);
        const allowed = new Set();
        if (homeModuleId) allowed.add(homeModuleId);
        if (parentClass && parentClass.kind==='class') allowed.add(parentClass.id);

        // If hovering a class that isn't ours, reject
        if (tNode && tNode.kind==='class' && !allowed.has(tNode.id)) { tNode=null; target=null; }
        // If hovering a module that isn't ours, reject
        if (tNode && tNode.kind==='module' && !allowed.has(tNode.id)) { tNode=null; target=null; }
        // If dropping inside rightful module but we belong to a class → snap to that class
        if (tNode && tNode.kind==='module' && parentClass && parentClass.parent===tNode.id) {
          target = parentClass.id; tNode = parentClass;
        }

        if (target) {
          // legal dock
          const C = D.consts || {}; const MOD_PAD=C.MOD_PAD||10; const MOD_HEAD=C.MOD_HEAD||28; const FUNC_H=(C.FUNC_H||42);
          node.parent = target; node.docked = true;
          const box = S.moduleBoxes.get(target);
          const w = (node._w || 180);
          if (box) {
            const isClass = !!(tNode && tNode.kind==='class');
            const headPad = isClass ? (22 + MOD_PAD) : (MOD_HEAD + MOD_PAD);
            const innerW = Math.max(0, (box.w||0) - MOD_PAD*2);
            const maxDx = MOD_PAD + Math.max(0, innerW - w);
            const rx = Math.max(MOD_PAD, Math.min(maxDx, (node.x||0) - box.x));
            const maxDy = Math.max(headPad, (box.h||0) - MOD_PAD - FUNC_H);
            const ry = Math.max(headPad, Math.min(maxDy, (node.y||0) - box.y));
            node.dx = rx; node.dy = ry;
            const gm = Array.from((G['gFuncsDocked']||document.createElement('g')).querySelectorAll('[data-owner]')).find(x=>x.getAttribute('data-owner')===target);
            if (gm) gm.appendChild(g);
            g.setAttribute('transform', `translate(${rx}, ${ry})`);
          }
        } else {
          // illegal: just remain free at the collider-resolved spot (no flash/bounce)
          node.docked = false;
          g.setAttribute('transform', `translate(${node.x||0}, ${node.y||0})`);
        }
      }
      try { if (node && node.kind!=='func') console.assert(S.moduleBoxes && S.moduleBoxes.has(node.id), 'DepViz: missing box for', node.id); } catch (e) { warn('enableFuncDrag/assert', e); }
      try { D.geom.updateEdgesForNode(node.id); } catch (e) { warn('enableFuncDrag/updateEdgesForNode', e); }
      D.util.resolveCollisions(node.docked ? 'func-docked' : 'func-free', node);
      D.schedule();
    };
    rect.addEventListener('mousedown', (e)=>{
      if (e.button!==0) return;
      e.stopPropagation(); e.preventDefault();
      dragging=true; rect.classList.add('dragging');
      const abs = node.docked ? D.geom.absTopLeftOf(node, funcW) : {x: node.x||0, y: node.y||0};
      const w = D.svg.clientToWorld(e);
      grab = { x: w.x - abs.x, y: w.y - abs.y };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function wireCollapseToggle(pathEl, moduleNode){
    pathEl.addEventListener('click', (e)=>{ e.stopPropagation(); moduleNode.collapsed = !moduleNode.collapsed; D.schedule(); });
  }

  function enableClassDrag(cg, rect, node){
    let dragging=false, grab={x:0,y:0}, rafId=null, lastPtr={x:0,y:0};
    const apply = (nx, ny, ptr)=>{
      try {
        const modBox = node.docked ? S.moduleBoxes.get(node.parent) : undefined;
        const clsBox = S.moduleBoxes.get(node.id);
        if (!node.docked || !modBox || !clsBox) {
          // Free: repel from NON-home modules only (ignore classes)
          const w = (clsBox?.w || 220), h = (clsBox?.h || 80);
          const allowed = new Set();
          if (node.parent) allowed.add(node.parent); 
          const out = pushOutFromModules(nx, ny, w, h, allowed);
          node.x = out.x; node.y = out.y;
          cg.setAttribute('transform', `translate(${out.x}, ${out.y})`);
          try {
            let gm = (G['gFuncsDocked']||document).querySelector(`[data-owner="${node.id}"]`);
            if (!gm) gm = (G['gFuncsFree']||document).querySelector(`[data-owner="${node.id}"]`);
            if (gm && G['gFuncsFree'] && gm.parentElement !== G['gFuncsFree']) G['gFuncsFree'].appendChild(gm);
            if (gm) gm.setAttribute('transform', `translate(${out.x}, ${out.y})`);
          } catch {}
          const b = S.moduleBoxes.get(node.id); if (b) { b.x = out.x; b.y = out.y; }
          try { for (const f of (S.data.nodes||[])) if (f.kind==='func' && f.parent===node.id) D.geom.updateEdgesForNode(f.id); } catch {}
          return;
        }
        const C = D.consts || {}; const MOD_PAD = C.MOD_PAD||10; const MOD_HEAD = C.MOD_HEAD||28; const HEAD_PAD = MOD_HEAD + MOD_PAD;
        // Current relative position within the module group
        const prevRelX = (clsBox.x - modBox.x);
        const prevRelY = (clsBox.y - modBox.y);
        // Detach when pointer OR class center leaves module (reduces magnet effect)
        const DETACH_PAD = (D.consts && D.consts.DETACH_PAD) || 24;
        const testX = (ptr && typeof ptr.x==='number') ? ptr.x : (nx + 10);
        const testY = (ptr && typeof ptr.y==='number') ? ptr.y : (ny + 10);
        const cenX = nx + Math.max(0, (clsBox.w||0))/2;
        const cenY = ny + Math.max(0, (clsBox.h||0))/2;
        if (!D.geom.within(modBox, testX, testY, DETACH_PAD) || !D.geom.within(modBox, cenX, cenY, DETACH_PAD)){
          // Detach: class to classes-free (below edges), methods group to funcs-free (above edges)
          node.docked = false; node.x = nx; node.y = ny;
          (G['gClassesFree']||document.body).appendChild(cg);
          try {
            const gm = (G['gFuncsDocked']||document).querySelector(`[data-owner="${node.id}"]`);
            if (gm && G['gFuncsFree']) G['gFuncsFree'].appendChild(gm);
            if (gm) gm.setAttribute('transform', `translate(${nx}, ${ny})`);
          } catch {}
          cg.setAttribute('transform', `translate(${nx}, ${ny})`);
          return;
        }
        // Clamp new relative position to module inner area
        const maxRelX = Math.max(MOD_PAD, (modBox.w||0) - MOD_PAD - (clsBox.w||0));
        const maxRelY = Math.max(HEAD_PAD, (modBox.h||0) - MOD_PAD - (clsBox.h||0));
        const relX = Math.max(MOD_PAD, Math.min(maxRelX, nx - modBox.x));
        const relY = Math.max(HEAD_PAD, Math.min(maxRelY, ny - modBox.y));
        // Move class container and its methods container together using absolute world coordinates
        const absX = modBox.x + relX, absY = modBox.y + relY;
        cg.setAttribute('transform', `translate(${absX}, ${absY})`);
        clsBox.x = absX; clsBox.y = absY; node.dx = relX; node.dy = relY;
        try {
          const gm = (G['gFuncsDocked']||document).querySelector(`[data-owner="${node.id}"]`) || (G['gFuncsFree']||document).querySelector(`[data-owner="${node.id}"]`);
          if (gm && G['gFuncsDocked'] && gm.parentElement !== G['gFuncsDocked']) G['gFuncsDocked'].appendChild(gm);
          if (gm) gm.setAttribute('transform', `translate(${absX}, ${absY})`);
        } catch {}
        // update edges for children while dragging
        try { for (const f of (S.data.nodes||[])) if (f.kind==='func' && f.parent===node.id && f.docked) D.geom.updateEdgesForNode(f.id); } catch {}
      } catch (e) { warn('enableClassDrag/apply', e); }
    };
    const onMove = (e)=>{
      if (!dragging) return;
      const w = D.svg.clientToWorld(e);
      lastPtr = { x: w.x, y: w.y };
      const nx = w.x - grab.x; const ny = w.y - grab.y;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(()=>apply(nx,ny,lastPtr));
    };
    const onUp = ()=>{
      if (!dragging) return;
      dragging=false; rect.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!node.docked) {
        const clsBox = S.moduleBoxes.get(node.id) || { x: node.x||0, y: node.y||0, w: 220, h: 80 };
        const center = { x: (clsBox.x||0) + (clsBox.w||220)/2, y: (clsBox.y||0) + (clsBox.h||80)/2 };
        // Find containing MODULE only (ignore classes), pick smallest area
        const hit = bestDockTarget(clsBox, ['module']);
        const target = hit?.id || null;
        // Only allow docking back into the class's original module
        if (target && target !== node.parent) {
          // illegal → stay free + flash
          cg.setAttribute('transform', `translate(${node.x||clsBox.x}, ${node.y||clsBox.y})`);
          const rectEl = cg.querySelector('rect.class') || cg.querySelector('rect');
          if (rectEl){ rectEl.classList.add('collision'); setTimeout(()=>rectEl.classList.remove('collision'), 220); }
        } else if (target) {
          node.parent = target; node.docked = true;
          // clamp inside module
          const modBox = S.moduleBoxes.get(target);
          if (modBox) {
            const C = D.consts || {}; const MOD_PAD=C.MOD_PAD||10; const HEAD_PAD=(C.MOD_HEAD||28)+MOD_PAD;
            const drop = (lastPtr && typeof lastPtr.x==='number') ? lastPtr : { x: (clsBox.x||0) + 10, y: (clsBox.y||0) + 10 };
            const maxRelX = Math.max(MOD_PAD, (modBox.w||0) - MOD_PAD - (clsBox.w||220));
            const maxRelY = Math.max(HEAD_PAD, (modBox.h||0) - MOD_PAD - (clsBox.h||80));
            const relX = Math.max(MOD_PAD, Math.min(maxRelX, drop.x - modBox.x));
            const relY = Math.max(HEAD_PAD, Math.min(maxRelY, drop.y - modBox.y));
            node.dx = relX; node.dy = relY;
            const absX = modBox.x + relX, absY = modBox.y + relY;
            cg.setAttribute('transform', `translate(${absX}, ${absY})`);
            const myBox = S.moduleBoxes.get(node.id);
            if (myBox) { myBox.x = absX; myBox.y = absY; }
            const gm = (G['gFuncsDocked']||document).querySelector(`[data-owner="${node.id}"]`);
            if (gm) gm.setAttribute('transform', `translate(${absX}, ${absY})`);
            (G['gClassesDocked']||document.body).appendChild(cg);
          }
        }
      }
      try { console.assert(S.moduleBoxes && S.moduleBoxes.has(node.id), 'DepViz: missing module box for', node.id); } catch (e) { warn('enableModuleDrag/assert', e); }
      try {
        D.geom.updateEdgesForNode(node.id);
        for (const f of (S.data.nodes||[])) if (f.kind==='func' && f.parent===node.id && f.docked) D.geom.updateEdgesForNode(f.id);
      } catch (e) { warn('enableModuleDrag/onUp updateEdges', e); }
      D.schedule();
    };
    rect.addEventListener('mousedown', (e)=>{
      if (e.button!==0) return;
      e.stopPropagation(); e.preventDefault();
      dragging=true; rect.classList.add('dragging');
      const clsBox = S.moduleBoxes.get(node.id) || { x: node.x||0, y: node.y||0 };
      const w = D.svg.clientToWorld(e);
      grab = { x: w.x - (clsBox.x||0), y: w.y - (clsBox.y||0) };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  D.interact = Object.freeze({ enableModuleDrag, enableFuncDrag, enableClassDrag, wireCollapseToggle });
})();


