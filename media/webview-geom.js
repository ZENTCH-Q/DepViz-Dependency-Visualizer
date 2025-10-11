// media/webview-geom.js

(function(){
  const D = globalThis.DepViz || (globalThis.DepViz = {});
  const S = D.state;
  const C = D.consts || {};

  function indexEdgeEl(e, el){
    const F = (D.indices = D.indices || {});
    F.edgesByFrom = F.edgesByFrom || new Map();
    F.edgesByTo   = F.edgesByTo   || new Map();
    if (!F.edgesByFrom.has(e.from)) F.edgesByFrom.set(e.from, []);
    if (!F.edgesByTo.has(e.to)) F.edgesByTo.set(e.to, []);
    F.edgesByFrom.get(e.from).push(el);
    F.edgesByTo.get(e.to).push(el);
    el._depvizEdge = e;
  }

  function updateEdgesForNode(nodeId){
    const F = D.indices || {};
    const outs = (F.edgesByFrom && F.edgesByFrom.get(nodeId)) || [];
    const ins  = (F.edgesByTo   && F.edgesByTo.get(nodeId))   || [];
    for (const pathEl of outs.concat(ins)) {
      const e = pathEl._depvizEdge;
      if (e) updateEdgePathFor(e, pathEl);
    }
  }

  function anchorPoint(n){
    const F = D.indices || {};
    if (!n) return {x:0,y:0};
    if (n.kind === 'func') {
      const parent = n.parent && F.nodeMap?.get(n.parent);
      if (parent && parent.kind==='module' && parent.collapsed && n.docked){
        const b = S.moduleBoxes.get(parent.id) || { x: parent.x||0, y: parent.y||0, w: 220, h: 120 };
        return { x: b.x + b.w/2, y: b.y + b.h/2 };
      }
      if (parent && parent.kind==='class' && n.docked) {
        const gp = parent.parent && F.nodeMap?.get(parent.parent);
        if (gp && gp.kind==='module' && gp.collapsed) {
          const b = S.moduleBoxes.get(gp.id) || { x: gp.x||0, y: gp.y||0, w: 220, h: 120 };
          return { x: b.x + b.w/2, y: b.y + b.h/2 };
        }
      }
      const tl = absTopLeftOf(n, n._w ?? (C.FUNC_W_DEFAULT || 180));
      return { x: tl.x + (n._w ?? (C.FUNC_W_DEFAULT || 180))/2, y: tl.y + (C.FUNC_H || 42)/2 };
    }
    if (n.kind === 'module') {
      const b = S.moduleBoxes.get(n.id) || { x: n.x||0, y: n.y||0, w: 220, h: 120 };
      return { x: b.x + b.w/2, y: b.y + b.h/2 };
    }
    return { x: n.x||0, y: n.y||0 };
  }

  function updateEdgePathFor(e, pathEl){
    const F = D.indices || {};
    const a = F.nodeMap?.get(e.from), b = F.nodeMap?.get(e.to);
    if (!a || !b) return;
    const p1 = anchorPoint(a);
    const p2 = anchorPoint(b);
    if (Math.abs(p1.x - p2.x) < 0.5 && Math.abs(p1.y - p2.y) < 0.5) {
      pathEl.setAttribute('d',''); pathEl.classList.add('hidden');
      if (pathEl._arrowEl) pathEl._arrowEl.setAttribute('display','none');
      return;
    }
    const midX = (p1.x + p2.x) / 2;
    const c1 = { x: midX, y: p1.y };
    const c2 = { x: midX, y: p2.y };
    pathEl.classList.remove('hidden');
    pathEl.setAttribute('d', `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`);
    // If there is a center-arrow for this edge, place it at t=0.5 with tangent rotation.
    if (pathEl._arrowEl) {
      const t = 0.5;
      const pt = cubicPoint(p1, c1, c2, p2, t);
      const dv = cubicDeriv(p1, c1, c2, p2, t);
      const angle = Math.atan2(dv.y, dv.x) * 180 / Math.PI;
      pathEl._arrowEl.setAttribute('display','');
      pathEl._arrowEl.setAttribute('transform', `translate(${pt.x}, ${pt.y}) rotate(${angle})`);
    }
  }

  function within(box, x, y, pad=0) { return box && x>=box.x-pad && x<=box.x+box.w+pad && y>=box.y-pad && y<=box.y+box.h+pad; }
  function moduleUnderPoint(x, y) {
    // Prefer the smallest container that contains the point (e.g., class over module)
    let best = null;
    let bestArea = Infinity;
    for (const [id, box] of S.moduleBoxes) {
      if (within(box, x, y)) {
        const area = (box.w||0) * (box.h||0);
        if (area && area < bestArea) { best = id; bestArea = area; }
      }
    }
    return best;
  }

  function absTopLeftOf(n, funcW){
    const MOD_PAD = C.MOD_PAD || 10;
    const MOD_HEAD = C.MOD_HEAD || 28;
    const DEF_W = C.FUNC_W_DEFAULT || 180;
    const DEF_H = C.FUNC_H || 42;
    const w = funcW || DEF_W;
    if (n.kind === 'func' && n.docked && n.parent) {
      const F = D.indices || {};
      const parentNode = F.nodeMap?.get(n.parent);
      // If function is inside a class, prefer anchoring to the class box (supports free-floating classes)
      if (parentNode && parentNode.kind === 'class') {
        const pBox = S.moduleBoxes.get(parentNode.id);
        if (pBox) {
          const innerW = pBox.w - MOD_PAD*2;
          const dx = (typeof n.dx === 'number') ? Math.max(MOD_PAD, Math.min(MOD_PAD + innerW - w, n.dx)) : MOD_PAD + Math.max(0, (innerW - w)/2);
          const minY = 22 + MOD_PAD; // class header height is ~22
          const dy = Math.max(minY, (n.dy ?? minY));
          return { x: pBox.x + dx, y: pBox.y + dy };
        }
        // Fallback to module anchor when class box is not available
        const modId = parentNode.parent;
        const m = S.moduleBoxes.get(modId) || { x: 0, y: 0, w: 220, h: 120 };
        const dx = (typeof n.dx === 'number') ? n.dx : MOD_PAD + Math.max(0, ((m.w - MOD_PAD*2) - w)/2);
        const dy = (typeof n.dy === 'number') ? n.dy : (MOD_HEAD + MOD_PAD);
        return { x: m.x + dx, y: m.y + dy };
      }
      // default: parent is a module
      if (S.moduleBoxes.has(n.parent)){
        const m = S.moduleBoxes.get(n.parent);
        const innerW = m.w - MOD_PAD*2;
        const dx = (typeof n.dx === 'number') ? Math.max(MOD_PAD, Math.min(MOD_PAD + innerW - w, n.dx)) : MOD_PAD + Math.max(0, (innerW - w)/2);
        const dy = Math.max(MOD_HEAD + MOD_PAD, (n.dy ?? MOD_HEAD + MOD_PAD));
        return { x: m.x + dx, y: m.y + dy };
      }
    }
    if (n.kind === 'module') return { x: n.x ?? 0, y: n.y ?? 0 };
    return { x: n.x ?? 0, y: n.y ?? 0 };
  }

  function elbow(a,b){ const midX=(a.x+b.x)/2; return `M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`; }
  function cubicPoint(p0,p1,p2,p3,t){
    const u=1-t;
    const x = u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x;
    const y = u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y;
    return {x,y};
  }
  function cubicDeriv(p0,p1,p2,p3,t){
    const u=1-t;
    const x = 3*u*u*(p1.x-p0.x) + 6*u*t*(p2.x-p1.x) + 3*t*t*(p3.x-p2.x);
    const y = 3*u*u*(p1.y-p0.y) + 6*u*t*(p2.y-p1.y) + 3*t*t*(p3.y-p2.y);
    return {x,y};
  }
  function isInternalEdge(e){
    const F = D.indices || {};
    const a = F.nodeMap?.get(e.from), b = F.nodeMap?.get(e.to);
    const isFuncLike = (n)=> n && (n.kind==='func' || n.kind==='class');
    const inClass = (n)=>{
      if (!n || !n.parent) return false;
      const p = F.nodeMap?.get(n.parent);
      return !!(p && p.kind === 'class');
    };
    const parentCollapsed = (n)=>{
      if (!n || !n.parent) return false;
      const p = F.nodeMap?.get(n.parent);
      return !!(p && p.kind==='module' && p.collapsed);
    };
    if (parentCollapsed(a) || parentCollapsed(b)) return false;
    // Any edge that touches a class (method↔method, method↔func, method↔class) goes in front.
    if (inClass(a) || inClass(b)) return true;
    // Otherwise: same-parent docked func/class edges count as internal (front).
    return a && b && isFuncLike(a) && isFuncLike(b) && a.docked && b.docked && a.parent && a.parent===b.parent;
  }

  D.geom = Object.freeze({ indexEdgeEl, updateEdgesForNode, anchorPoint, updateEdgePathFor, within, moduleUnderPoint, absTopLeftOf, elbow, isInternalEdge });
})();

