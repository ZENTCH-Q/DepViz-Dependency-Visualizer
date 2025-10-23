# DepViz — Call Graphs for VS Code (

Interactive **code maps** in **VS Code**. See **who calls what**, how modules → classes → functions connect, with **call** (solid, arrowed) and **import** (dashed) edges. **Python / TypeScript / JavaScript**. Export stuff.

![Showcase](https://github.com/user-attachments/assets/33de3d2e-513a-4a20-bf1e-c599ffe845b9)

## Why bother
- **Answer “what breaks if I touch X?”** in seconds.
- **Jump** to code (Go to Definition / Peek References).
- **Slice impact** inbound/outbound to see blast radius.
- **Export** PNG / SVG / JSON / snapshot (`.dv`).

## Install
- VS Code → Extensions → search **DepViz** → install.  
- Or `code --install-extension depviz-*.vsix` if you like pain.

## Quick start
1. `DepViz: Open` (Command Palette) → empty canvas.  
2. **Drag files/folders** in, or `DepViz: Import`.  
3. Pan (mouse), zoom (wheel), right-click canvas for actions.  
4. Click legend to toggle **call/import** visibility.

## Features (you’ll use)
- **Import** from Explorer / drag & drop.  
- **See** modules, classes, functions; **edges**: call ✅, import ✅.  
- **Arrange**: folders (Ctrl/Cmd+Shift+A) or balanced grid (…+B).  
- **Search labels** (Ctrl/Cmd+F) with live highlighting.  
- **Impact slices**: right-click node → Outbound / Inbound / Clear.  
- **Export**: PNG / SVG / JSON / `.dv` snapshot.  
- **Snapshots**: open `.dv` as a custom editor; Ctrl/Cmd+S saves.

## Shortcuts (remember two)
- **Arrange by folders**: Ctrl/Cmd+Shift+A  
- **Balanced grid**: Ctrl/Cmd+Shift+B  
- **Search**: Ctrl/Cmd+F  
- **Toggle help**: Ctrl/Cmd+/  
- **Clear slice**: Ctrl/Cmd+Shift+S  
- **Undo/Redo**: Ctrl/Cmd+Z / Shift+Z or Y  
- **Zoom**: `+` / `-`, **Pan**: arrows

## Drag rules (no surprises)
- **Functions** and **classes** drag.  
- Drop near their **home** (module/class) to re-dock; otherwise they float.  
- Cards won’t overlap: collisions get nudged.  
- Right-click anything for context actions.

## Settings (because projects are messy)
```jsonc
// Settings → “DepViz”
"depviz.maxFiles": 2000,           // hard cap per import
"depviz.maxFileSizeMB": 1.5,       // skip huge files
"depviz.includeGlobs": ["**/*"],   // what to scan
"depviz.excludeGlobs": [           // what to ignore
  "**/.git/**", "**/node_modules/**", "**/__pycache__/**"
]
```

## Parsing (don’t @ me)
- Uses VS Code symbols when available; falls back to a heuristic parser.  
- Handles Python + TS/JS. Calls = best-effort: name-based, scope-aware enough to be useful.  
- Imports detected from `import`/`from…import`/`require`.  
- Yes, dynamic/reflective nonsense will fool it. Bring tests, not tears.

## Known limits / gotchas
- Not a typechecker. If two functions share a name, it picks the closest import/module match.  
- Huge repos: tune `maxFiles`, `maxFileSizeMB`, and globs.  
- Impact slice summary (copy file list) appears when opened via the main panel; the `.dv` custom editor is view-only for that part.

## Export
Right-click canvas → **Export** → PNG / SVG / JSON / `.dv`.  
SVG includes styles; PNG renders the current viewport.

## Uninstall note
It won’t touch your code. It only reads files and writes snapshots you save.

---

**TL;DR:** drag code in, see who calls who, slice blast radius, export receipts.

This extension is a prototype I'm working on to make it robust and reliable. stay tune :)
