# DepViz — Dependency Visualizer (VS Code)

Visualize function calls, imports, and architecture right inside VS Code. Works great with Python and TypeScript/JavaScript (and other languages via your LSP).
---
![Showcase](https://github.com/user-attachments/assets/33de3d2e-513a-4a20-bf1e-c599ffe845b9)

## Features

- **Interactive graph canvas** of modules, classes, and functions
- **call edges** with live type toggles in the legend
- **Impact slice** (blast radius) both outbound and inbound
- **Drag & drop** folders/files/URLs to import
- **Auto‑arrange** to tidy your canvas
- **Search popup** with on‑graph highlights and cycling
- **Export** to SVG/PNG/JSON or a DepViz snapshot (`.dv`)
- **Status dot** on module cards reflecting LSP health (see below)

---

## Commands

> Open the Command Palette and run these by name.

- `DepViz: Open` — open the DepViz canvas/editor
- `DepViz: Import into Canvas` — import a folder / selection
- `DepViz: Import Active File` — import just the current file
- `DepViz: Diagnose LSP` — quick checks for your language server

### Default Keybinding

- **Open DepViz**: `Ctrl+Alt+D` (Windows/Linux) or `Cmd+Alt+D` (macOS)

> No other global keybindings are declared by the extension. Anything listed below under **In‑Canvas Shortcuts** is local to the DepViz webview when it has focus.

---

## Settings

All settings live under the `depviz.*` namespace.

- `depviz.autoSaveSnapshot` (boolean, default **true**)  
  Automatically save the `.dv` snapshot whenever the graph changes.

- `depviz.maxFiles` (number, default **500**, minimum **1**)  
  Maximum number of files to import per operation.

- `depviz.maxFileSizeMB` (number, default **1.5**, minimum **1**)  
  Skip files larger than this size (in megabytes).

- `depviz.includeGlobs` (string[], default **["**/*"]**)  
  Glob patterns to include when importing from folders.

- `depviz.excludeGlobs` (string[], default **["**/.git/**", "**/node_modules/**", "**/__pycache__/**"]**)  
  Glob patterns to exclude when importing from folders.

> Note: If you previously saw other settings referenced, they no longer exist and have been removed from the docs.

---

## Using the Canvas

### Pan & Zoom
- **Zoom**: mouse wheel (centered on cursor) or `+` / `-`
- **Pan**: click‑drag empty space or use arrow keys

### Selecting & Context Menus
- Right‑click **modules/classes/functions** or **edges** for actions like **Focus**, **Impact slice**, **Open File / Go to definition**, **Peek call sites**, **Re‑attach to parent**, or **Remove from canvas**.

### Impact Slice (Blast Radius)
- **Outbound**: nodes/edges you *reach* from the selection
- **Inbound**: nodes/edges that *reach* the selection
- Clear slice with **Esc** or `Ctrl/Cmd+Shift+S`

### Legend (Edge Types)
- Click legend items to toggle visibility per edge type:
  - **import** — module import edges (solid line) (Removed due to noise and misinterpretation)
  - **call** — function/method call edges (solid line with a centered triangle marker)

### Search
- Press `/` (or run the canvas command **Show Search**) to open the popup, type a query, then:
  - **Enter** / **Shift+Enter**: next/previous match
  - **Esc**: close search & clear highlights
- If exactly one match is found, the camera centers on it.

### Export
- From the canvas menu, export to **SVG**, **PNG**, **JSON** (graph only), or a **DepViz snapshot** (`.dv` includes camera & visibility state).

### In‑Canvas Shortcuts
- **Auto‑arrange**: `Ctrl/Cmd+Shift+A`
- **Clear current impact slice**: `Ctrl/Cmd+Shift+S` or **Esc**
- **Save snapshot**: `Ctrl/Cmd+S`
- **Zoom**: `+` / `-`
- **Pan**: Arrow keys

> These shortcuts are handled by the webview and only apply when the DepViz canvas has focus.

---

## Module Status Dot — Color Meaning

Every **module card** shows a small status dot in the top‑right indicating LSP (language server) health for that module’s file(s):

- 🟢 **Green** — `ok`  
  Language server data loaded and symbol resolution is healthy.

- 🟠 **Amber** — `partial`  
  Language server responded but data may be incomplete (e.g., partial indexing). Some features like cross‑file call detection may be reduced.

- 🔴 **Red** — `nolsp`  
  No language server data available. You can still import by text scanning, but advanced navigation and call graphs may be limited.

> Tip: Run **DepViz: Diagnose LSP** from the Command Palette to troubleshoot server issues for your workspace.

---

## Data Model (Quick Ref)

- **Nodes**: `module`, `class`, `func`
- **Edges**: `import`, `call`
- **Docked** nodes render inside their parent card; undocked nodes are free‑floating.
- **Snapshots** (`.dv`) save pan/zoom/visibility + full graph data.

---

## Troubleshooting

- If imports seem incomplete, ensure your `depviz.excludeGlobs` aren’t hiding needed files.
- For large workspaces, consider lowering `depviz.maxFiles` or raising `depviz.maxFileSizeMB` appropriately.
- Ensure your language server is running and not paused; check the **Status Dot**.

---

## License

MIT © 2025
