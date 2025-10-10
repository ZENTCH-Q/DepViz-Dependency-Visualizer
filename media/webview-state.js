// media/webview-state.js
(function(){
  const D = globalThis.DepViz || (globalThis.DepViz = {});
  const S = (D.state = D.state || {
    pan:{x:0,y:0}, zoom:1,
    data:{nodes:[],edges:[]},
    moduleBoxes:new Map(),
    needsFrame:false,
    typeVisibility:{import:true, call:true},
    focusId:null, focusModuleId:null,
    lastCursorWorld:{x:0,y:0},
    spawnSeq:0, lastSpawnAtMs:0, spawnOrigin:null,
    searchHit:null, searchQuery:'', searchMatches:[], searchIndex:-1,
    _hist:[], _histIndex:-1
  });

  let _lastSentHash = '';
  const FNV = (s)=>{ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return (h>>>0).toString(16); };

  function snapshot(){
    return { version:1, pan:S.pan, zoom:S.zoom, typeVisibility:S.typeVisibility, data:S.data };
  }

  function applySnapshot(snap){
    if (!snap) return;
    S.pan = snap.pan || {x:0,y:0};
    S.zoom = typeof snap.zoom==='number' ? snap.zoom : 1;
    S.typeVisibility = snap.typeVisibility || { import:true, call:true };
    S.data = snap.data || { nodes:[], edges:[] };
    try { D.data && D.data.normalizeNodes && D.data.normalizeNodes(); } catch {}
  }

  function pushHistory(vscode,label='Edit'){
    const snap = snapshot();
    const text = JSON.stringify(snap);
    const h = FNV(text);
    if (h === _lastSentHash) return;
    if (S._histIndex < S._hist.length - 1) S._hist = S._hist.slice(0, S._histIndex + 1);
    S._hist.push(snap); S._histIndex = S._hist.length - 1;
    if (S._hist.length > 100) { S._hist.shift(); S._histIndex--; }
    _lastSentHash = h;
    try { vscode && vscode.postMessage({ type:'edit', payload:snap, label }); } catch {}
  }

  function debounceDirty(vscode){
    let raf = null;
    return function(){
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(()=>pushHistory(vscode, 'Graph change'));
    };
  }

  function undo(vscode){
    if (S._histIndex <= 0) return;
    S._histIndex--;
    applySnapshot(S._hist[S._histIndex]);
    try { vscode && vscode.postMessage({ type:'edit', payload: snapshot(), label:'Undo' }); } catch {}
  }
  function redo(vscode){
    if (S._histIndex >= S._hist.length - 1) return;
    S._histIndex++;
    applySnapshot(S._hist[S._histIndex]);
    try { vscode && vscode.postMessage({ type:'edit', payload: snapshot(), label:'Redo' }); } catch {}
  }

  D.stateApi = Object.freeze({ snapshot, applySnapshot, pushHistory, debounceDirty, undo, redo });
})();
