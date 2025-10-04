// src/extension.ts
import * as vscode from 'vscode';
import { RelativePattern } from 'vscode';
import { registerAllLanguages } from './langs/registerAll';
import { pickByExt } from './langs/registry';
import { GraphNode, GraphEdge, Confidence } from './core/types';
import { fnv1a32 as hash } from './core/hash';
import { makeEdgeKey } from './core/indices';
import { indexModuleNodes, clearIndex, uniqueGlobalMatch } from './core/symbolIndex';
import { normalizePosixPath as normPosix, toPosix as toPosixCore } from './core/paths';
import { initDiag, onceWarn, warn as dWarn, error as dError, info as dInfo, open as openDiag } from './core/diag';

// minimal shim so we don't need @types/node
declare const Buffer: any;

let singletonPanel: vscode.WebviewPanel | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let totals = { modules: 0, funcs: 0 };

export function activate(context: vscode.ExtensionContext) {
  initDiag(context);
  registerAllLanguages();
  const openCmd = vscode.commands.registerCommand('depviz.open', () => {
    openPanel(context);
  });

  const importCmd = vscode.commands.registerCommand('depviz.import', async (uri?: vscode.Uri) => {
    const panel = openPanel(context);
    if (!panel) { return; }
    const cfg = vscode.workspace.getConfiguration('depviz');
    const maxFiles = cfg.get<number>('maxFiles') ?? 2000;
    if (!uri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: 'Import to DepViz'
      });
      if (!picked) return;
      await importMany(picked, panel, context, maxFiles);
    } else {
      await importMany([uri], panel, context, maxFiles);
    }
  });

  context.subscriptions.push(openCmd, importCmd);
  // Custom editor for .dv snapshots
  const provider = new DepvizDvProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('depviz.graph', provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true
    })
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'depviz.open';
  statusBar.text = `DepViz: $(graph) Ready`;
  statusBar.tooltip = 'Open DepViz';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Auto-refresh the canvas on save when the panel is open
  const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    try {
      if (!singletonPanel) return; // refresh only when DepViz is open
      if (!isInWorkspace(doc.uri)) return;
      const ext = extOf(doc.uri.path);
      if (SKIP_EXTS.has(ext)) return;
      await importUri(doc.uri, singletonPanel, context);
    } catch {}
  });
  context.subscriptions.push(onSave);
}

export function deactivate() {}

class DvDocument implements vscode.CustomDocument {
  static async create(uri: vscode.Uri): Promise<DvDocument> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      bytes = new Uint8Array();
    }
    const text = bytes && bytes.length ? decodeUtf8(bytes)
      : '{"version":1,"pan":{"x":0,"y":0},"zoom":1,"typeVisibility":{"import":true,"call":true},"data":{"nodes":[],"edges":[]}}';
    return new DvDocument(uri, text);
  }
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  private readonly _onDidChange = new vscode.EventEmitter<{ label?: string; undo(): void; redo(): void }>();
  public readonly onDidDispose = this._onDidDispose.event;
  public readonly onDidChangeCustomDocument = this._onDidChange.event;
  private _text: string;
  private _savedText: string;
  private constructor(public readonly uri: vscode.Uri, initialText: string) {
    this._text = initialText;
    this._savedText = initialText;
  }
  dispose() {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidChange.dispose();
  }
  getText() { return this._text; }
  applyEdit(nextText: string, label = 'Edit graph') {
    const prev = this._text;
    if (prev === nextText) return;
    this._text = nextText;
    this._onDidChange.fire({
      label,
      undo: () => { this._text = prev; },
      redo: () => { this._text = nextText; }
    });
  }
  async save(_token: vscode.CancellationToken): Promise<void> {
    await vscode.workspace.fs.writeFile(this.uri, Buffer.from(this._text, 'utf8'));
    this._savedText = this._text;
  }
  async saveAs(target: vscode.Uri, _token: vscode.CancellationToken): Promise<void> {
    await vscode.workspace.fs.writeFile(target, Buffer.from(this._text, 'utf8'));
    this._savedText = this._text;
  }
  async revert(_token: vscode.CancellationToken): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(this.uri);
    const text = decodeUtf8(bytes);
    const prev = this._text;
    this._text = text;
    this._savedText = text;
    this._onDidChange.fire({
      label: 'Revert',
      undo: () => { this._text = prev; },
      redo: () => { this._text = text; }
    });
  }
  async backup(destination: vscode.Uri, _token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(destination, Buffer.from(this._text, 'utf8'));
    return { id: destination.toString(), delete: async () => { try { await vscode.workspace.fs.delete(destination); } catch {} } };
  }
}

class DepvizDvProvider implements vscode.CustomEditorProvider<DvDocument> {
  private readonly _onDidChangeCustomDocument =
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DvDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  private readonly _docSubs = new WeakMap<DvDocument, vscode.Disposable>();

  constructor(private ctx: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<DvDocument> {
    const doc = await DvDocument.create(uri);
    // Bridge document edits to provider event (adds undo/redo + label)
    const sub = doc.onDidChangeCustomDocument(edit => {
      this._onDidChangeCustomDocument.fire({
        document: doc,
        ...edit
      });
    });
    this._docSubs.set(doc, sub);
    return doc;
  }

  async saveCustomDocument(document: DvDocument, token: vscode.CancellationToken): Promise<void> {
    return document.save(token);
  }
  async saveCustomDocumentAs(document: DvDocument, targetResource: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
    return document.saveAs(targetResource, token);
  }
  async revertCustomDocument(document: DvDocument, token: vscode.CancellationToken): Promise<void> {
    return document.revert(token);
  }
  async backupCustomDocument(document: DvDocument, context: vscode.CustomDocumentBackupContext, token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, token);
  }

  async resolveCustomEditor(document: DvDocument, panel: vscode.WebviewPanel) {
   panel.webview.options = {
     enableScripts: true,
     localResourceRoots: [this.ctx.extensionUri]
   };
    // Same HTML as main, but signal “NO_SAMPLE” so webview skips sample fetch
    const scriptUri          = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.js'));
    const scriptGeomUri      = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview-geom.js'));
    const scriptInteractUri  = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview-interact.js'));
    const scriptArrangeUri   = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview-arrange.js'));
    const scriptDataUri      = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview-data.js'));
    const styleUri     = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.css'));
    const codiconUri   = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'codicon.css'));
    const iconDarkUri  = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'depviz-dark.svg'));
    const iconLightUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'depviz-light.svg'));

    panel.webview.html = getHtmlCustom(panel, {
      scriptUris: [scriptUri.toString(), scriptGeomUri.toString(), scriptInteractUri.toString(), scriptArrangeUri.toString(), scriptDataUri.toString()],
      styleUri: styleUri.toString(),
      codiconUri: codiconUri.toString(),
      iconDark: iconDarkUri.toString(),
      iconLight: iconLightUri.toString()
    });

    try {
      const snap = JSON.parse(document.getText());
      panel.webview.postMessage({ type: 'loadSnapshot', payload: snap });
    } catch (e:any) {
      // invalid or empty file: ignore, user can save later
      if (e?.message) vscode.window.showErrorMessage(`DepViz: invalid .dv (${e.message})`);
    }

    panel.webview.onDidReceiveMessage(async (message:any) => {
  try {
    switch (message.type) {
      case 'edit': {
        const text = JSON.stringify(message.payload ?? {}, null, 2);
        document.applyEdit(text, message.label || 'Graph change');
        break;
      }
      case 'openFile': {
        const fsPath = String(message.fsPath ?? '');
        const u = vscode.Uri.file(fsPath);
        if (u.scheme !== 'file') throw new Error('Only file:// URIs allowed');
        if (!isInWorkspace(u)) throw new Error('Path not inside workspace');
        const doc = await vscode.workspace.openTextDocument(u);
        await vscode.window.showTextDocument(doc, { preview: false });
        break;
      }
      case 'openAt': {
        const fsPath = String(message.fsPath ?? '');
        const line = Math.max(0, Number(message.line ?? 0)|0);
        const col = Math.max(0, Number(message.col ?? 0)|0);
        const view = String(message.view || '').toLowerCase();
        const u = vscode.Uri.file(fsPath);
        if (u.scheme !== 'file') throw new Error('Only file:// URIs allowed');
        if (!isInWorkspace(u)) throw new Error('Path not inside workspace');
        const doc = await vscode.workspace.openTextDocument(u);
        const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: view==='beside' ? vscode.ViewColumn.Beside : undefined });
        const pos = new vscode.Position(Math.min(line, doc.lineCount-1), col);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        break;
      }
      case 'exportData': {
        const kind = String(message.kind || 'json');
        const suggestedName = String(message.suggestedName || `graph.${kind}`);
        const bytes = Buffer.from(String(message.base64||''), 'base64');
        const filters: Record<string,string[]> =
          kind==='svg' ? { 'SVG': ['svg'] } :
          kind==='png' ? { 'PNG Image': ['png'] } :
          kind==='dv'  ? { 'DepViz Graph': ['dv','json'] } :
                         { 'JSON': ['json'] };
        const uri = await vscode.window.showSaveDialog({ filters, defaultUri: vscode.Uri.file(suggestedName) });
        if (!uri) return; // user cancelled
        await vscode.workspace.fs.writeFile(uri, bytes);
        vscode.window.showInformationMessage(`DepViz: Exported ${kind.toUpperCase()} to ${uri.fsPath}`);
        break;
      }

      case 'saveSnapshot': {
        try {
          const snap = message.payload || {};
          const text = JSON.stringify(snap, null, 2);
          document.applyEdit(text, 'Save graph');
          await document.save(new vscode.CancellationTokenSource().token);
          vscode.window.setStatusBarMessage('DepViz: Snapshot saved', 2000);
        } catch (e:any) {
          vscode.window.showErrorMessage(`DepViz: Save failed: ${e?.message || e}`);
        }
        break;
      }
      case 'requestImportJson': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, filters: { 'JSON': ['json'] } });
        if (!picked || !picked.length) break;
        const content = await vscode.workspace.fs.readFile(picked[0]);
        const text = decodeUtf8(content);
        try { panel.webview.postMessage({ type: 'addArtifacts', payload: JSON.parse(text) }); }
        catch (e:any) { vscode.window.showErrorMessage(`DepViz: Failed to import JSON: ${e?.message ?? e}`); }
        break;
      }
      case 'requestImportSnapshot': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, filters: { 'DepViz Graph': ['dv','json'] } });
        if (!picked || !picked.length) break;
        try {
          const content = await vscode.workspace.fs.readFile(picked[0]);
          const text = decodeUtf8(content);
          panel.webview.postMessage({ type: 'loadSnapshot', payload: JSON.parse(text) });
          vscode.window.showInformationMessage(`DepViz: Loaded snapshot ${picked[0].fsPath}`);
        } catch (e:any) {
          vscode.window.showErrorMessage(`DepViz: Failed to load snapshot: ${e?.message ?? e}`);
        }
        break;
      }
      case 'droppedUris': {
        const items: string[] = Array.isArray(message.items) ? message.items : [];
        const uris: vscode.Uri[] = [];
        for (const raw of items) { try { uris.push(toSafeFileUri(raw)); } catch {} }
        const cfg = vscode.workspace.getConfiguration('depviz');
        const maxFiles = cfg.get<number>('maxFiles') ?? 2000;
        await importMany(uris, panel, this.ctx, maxFiles);
        break;
      }
      case 'clearCanvas': {
        totals = { modules: 0, funcs: 0 };
        try { (FINGERPRINTS as any as Map<string,string>).clear(); } catch {}
        clearIndex();
        updateStatusBar();
        break;
      }
      case 'evictFingerprint': {
        try {
          const fsPath = String(message.fsPath || '');
          if (fsPath) (FINGERPRINTS as any as Map<string,string>).delete(normalizePath(fsPath));
        } catch {}
        break;
      }
      case 'gotoDef': {
        const t = message.target || {};
        const name = String(t.name || '');
        const file = t.file ? String(t.file) : undefined;
        const view = String(message.view || '').toLowerCase();
        await gotoSymbol({ file, name }, /*peek*/ false, view==='beside');
        break;
      }
      case 'peekRefs': {
        const t = message.target || {};
        const name = String(t.name || '');
        const file = t.file ? String(t.file) : undefined;
        const view = String(message.view || '').toLowerCase();
        await gotoSymbol({ file, name }, /*peek*/ true, view==='beside');
        break;
      }
    }
  } catch (e:any) {
    vscode.window.showErrorMessage(`DepViz: ${e?.message||e}`);
  }
});
    panel.onDidDispose(() => { this._docSubs.get(document)?.dispose(); });
  }
}

function getHtmlCustom(panel: vscode.WebviewPanel, deps: {
  scriptUris: string[];
  styleUri: string;
  codiconUri: string;
  iconDark: string;
  iconLight: string;
}) {
  // Same as getHtml but without DATA_URI; we set NO_SAMPLE to skip sample fetch.
  const html = getHtml(panel, {
    scriptUris: deps.scriptUris,
    styleUri: deps.styleUri,
    dataUri: '', // no sample
    codiconUri: deps.codiconUri,
    iconDark: deps.iconDark,
    iconLight: deps.iconLight
  });
  return html.replace(
    'window.DEPVIZ = { DATA_URI: "" };',
    'window.DEPVIZ = { DATA_URI: "", NO_SAMPLE: true };'
  );
}
// LSP helper: fail fast and fall back
const LSP_TIMEOUT_MS = 800;
async function lsp<T>(cmd: string, ...args:any[]): Promise<T | null> {
  try {
    return await Promise.race([
      vscode.commands.executeCommand<T>(cmd, ...args),
      new Promise<null>(res => setTimeout(() => res(null), LSP_TIMEOUT_MS))
    ]);
  } catch (e:any) {
    dWarn(`LSP command ${cmd} failed: ${e?.message ?? e}`);
    return null;
  }
}

// LSP-aware parsing entry point; falls back to naive regex parser
async function parseFileLspAware(uri: vscode.Uri, text: string) {
  const fileLabel = vscode.workspace.asRelativePath(uri, false);   // for display
  const moduleLabelKey = normPosix(uri.fsPath);
  const moduleId = `mod_${hash(moduleLabelKey)}`;
  const nodes: any[] = [{ id: moduleId, kind: 'module', label: fileLabel, fsPath: uri.fsPath, source: text }];
  const edges: any[] = [];

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const res = await lsp<any>('vscode.executeDocumentSymbolProvider', uri);
    const symbols: vscode.DocumentSymbol[] = Array.isArray(res) ? res : [];
    if (!symbols.length) {
      return parseFile(uri, text);
    }

    type Fn = { id: string; name: string; start: number; end: number; col: number; parent: string };
    const fns: Fn[] = [];
    const classIds = new Map<string,string>();
    const addFn = (name: string, sel: vscode.Range, full: vscode.Range, parent: string) => {
      const id = `fn_${hash(fileLabel + ':' + name + ':' + sel.start.line)}`;
      fns.push({ id, name, start: sel.start.line, end: full.end.line, col: sel.start.character, parent });
    };
    const walk = (s: vscode.DocumentSymbol) => {
      if (s.kind === vscode.SymbolKind.Class) {
        // add a class node as a card inside the module
        const className = s.name;
        if (!classIds.has(className)) {
          const clsId = `cls_${hash(fileLabel + ':' + className)}`;
          classIds.set(className, clsId);
          nodes.push({ id: clsId, kind: 'class', label: `class ${className}`, parent: moduleId, docked: true, snippet: doc.getText(s.range).split(/\r?\n/).slice(0,20).join('\n'), fsPath: uri.fsPath, range: { line: s.selectionRange.start.line, col: s.selectionRange.start.character } });
        }
        for (const c of (s.children || [])) {
          if (c.kind === vscode.SymbolKind.Method || c.kind === vscode.SymbolKind.Function) {
            const clsId = classIds.get(className)!;
            addFn(`${s.name}.${c.name}`, c.selectionRange ?? c.range, c.range, clsId);
          }
        }
      } else if (s.kind === vscode.SymbolKind.Function) {
        addFn(s.name, s.selectionRange ?? s.range, s.range, moduleId);
      }
      for (const ch of (s.children || [])) walk(ch);
    };
    symbols.forEach(walk);

    // Fallback if none discovered
    if (!fns.length) return parseFile(uri, text);

    const lines = text.split(/\r?\n/);
    for (const fn of fns) {
      nodes.push({ id: fn.id, kind: 'func', label: `def ${fn.name}()`, parent: fn.parent, docked: true, snippet: snippetFrom(lines, fn.start), fsPath: uri.fsPath, range: { line: fn.start, col: fn.col } });
    }

    // Within-file call edges (heuristic)
    const bare = (n: string) => (n.includes('.') ? n.split('.').pop() || n : n);
    const nameToIds = new Map<string, string[]>();
    for (const fn of fns) {
      const k = bare(fn.name);
      if (!nameToIds.has(k)) nameToIds.set(k, []);
      nameToIds.get(k)!.push(fn.id);
    }
    const reCache = new Map<string, RegExp>();
    // local helpers so we don't rely on globals
    const wcr = (t: string) => new RegExp(String.raw`\b${escapeReg(t)}\s*\(`);
    const bareTokOf = (s: string) => (s.includes('.') ? s.split('.').pop() || s : s);
    const bodyOf = (fn: Fn) => {
      try { return doc.getText(new vscode.Range(new vscode.Position(fn.start, 0), new vscode.Position(fn.end + 1, 0))); } catch { return lines.slice(fn.start, fn.end + 1).join('\n'); }
    };
    const USE_LSP_REFS = false; // was true; disabled to avoid dropping edges incorrectly
    for (const fn of fns) {
      const body = stripStringsAndComments(bodyOf(fn));
      for (const [calleeToken, ids] of nameToIds) {
        if (ids.includes(fn.id)) continue;
        const bareTok = bareTokOf(calleeToken);
        let re = reCache.get(bareTok);
        if (!re) { re = wcr(bareTok); reCache.set(bareTok, re); }
        if (re.test(body) || (calleeToken !== bareTok && wcr(calleeToken).test(body))) {
          // LSP gate removed: previous check queried refs at the CALLER position, dropping valid edges.
          edges.push({ from: fn.id, to: ids[0], type: 'call', confidence: 'regex' });
        }
      }
    }

    // Imports (NO ghost nodes)
    const T0 = normalizeContinuations(stripStringsAndComments(text));
    // py: from PKG import a, b as c | import PKG as alias
    const impPy = /(?:^|\n)\s*(?:from\s+([\w\.]+)\s+import\s+([A-Za-z0-9_\,\s\*\.]+)|import\s+([\w\.]+)(?:\s+as\s+\w+)?)/g;
    // ts/js: import … from 'x' | import 'x' | require('x') | export … from 'x'
    const impTs = /(?:^|\n)\s*(?:import\s+(?:[^'"]+)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|export\s+[^;]+?\s+from\s+['"]([^'"]+)['"])/g;

    let m: RegExpExecArray | null;
    while ((m = impPy.exec(T0)) !== null) {
      const target = (m[1] ?? m[3] ?? '').trim();
      if (!target) continue;
      const label = resolveImportLabelByText(fileLabel, target, 'py');
      const to = label ? `mod_${hash(label)}` : `mod_${hash(target)}`;
      // only emit the edge; do NOT create a placeholder node
      edges.push({ from: moduleId, to, type: 'import', confidence: 'regex' });
    }
    while ((m = impTs.exec(T0)) !== null) {
      const target = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (!target) continue;
      const label = resolveImportLabelByText(fileLabel, target, 'ts');
      const to = label ? `mod_${hash(label)}` : `mod_${hash(target)}`;
      // only emit the edge; do NOT create a placeholder node
      edges.push({ from: moduleId, to, type: 'import', confidence: 'regex' });
    }

    return { nodes, edges };
  } catch {
    return parseFile(uri, text);
  }
}


function normalizeContinuations(src: string): string {
  // join line continuations and parenthesized import lists
  // 1) backslash continuations
  let s = src.replace(/\\\r?\n/g, ' ');
  // 2) flatten lines inside "from X import (a,\n  b as c,\n)" blocks
  s = s.replace(/from\s+[\w\.]+\s+import\s*\(([\s\S]*?)\)/g, (m, inner) => m.replace(/\r?\n/g, ' '));
  return s;
}

function stripStringsAndComments(src: string): string {
  // Remove comments and string *literals*, but keep `${ ... }` bodies inside template strings.
  let s = src;
  // JS/TS block + line comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Python comments + triple-quoted blocks
  s = s.replace(/^[ \t]*#.*$/gm, '');
  s = s.replace(/("""|''')[\s\S]*?\1/g, '');
  // Single/double quotes → wipe
  s = s.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '');
  // Backticks: drop literal chunks, keep ${...}
  s = s.replace(/`(?:\\.|[^\\`$]|(\$\{[\s\S]*?\}))*`/g, (m) => {
    // extract ${...} segments and join with a space
    const parts = [];
    const re = /\$\{([\s\S]*?)\}/g;
    let k: RegExpExecArray | null;
    while ((k = re.exec(m))) parts.push(k[1]);
    return parts.join(' ');
  });
  return s;
}


function openPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (singletonPanel) {
    singletonPanel.reveal(vscode.ViewColumn.Beside);
    return singletonPanel;
  }

  const panel = vscode.window.createWebviewPanel(
    'depviz',
    'DepViz',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  singletonPanel = panel;
  panel.onDidDispose(() => { singletonPanel = undefined; });

  // Fresh session: reset counters and dedupe fingerprints so re-importing works after close/reopen
  try { (FINGERPRINTS as any as Map<string,string>).clear(); } catch {}
  totals = { modules: 0, funcs: 0 };
  clearIndex();
  updateStatusBar();

  vscode.window.showInformationMessage(
    'DepViz opened. Import files to see something.',
    'Import...', 'Load Sample'
  ).then(async pick => {
    if (pick === 'Import...') { vscode.commands.executeCommand('depviz.import'); }
    if (pick === 'Load Sample') { panel.webview.postMessage({ type: 'requestSample' }); }
  });

  const scriptUri          = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.js'));
  const scriptGeomUri      = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview-geom.js'));
  const scriptInteractUri  = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview-interact.js'));
  const scriptArrangeUri   = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview-arrange.js'));
  const scriptDataUri      = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview-data.js'));
  const styleUri     = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css'));
  const dataUri      = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'sampleData.json'));
  const codiconUri   = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'codicon.css'));
  const iconDarkUri  = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'depviz-dark.svg'));
  const iconLightUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'depviz-light.svg'));

  panel.webview.html = getHtml(panel, {
    scriptUris: [
      scriptUri.toString(),
      scriptGeomUri.toString(),
      scriptInteractUri.toString(),
      scriptArrangeUri.toString(),
      scriptDataUri.toString()
    ],
    styleUri: styleUri.toString(),
    dataUri: dataUri.toString(),
    codiconUri: codiconUri.toString(),
    iconDark: iconDarkUri.toString(),
    iconLight: iconLightUri.toString()
  });

  panel.webview.onDidReceiveMessage(async message => {
    try {
      switch (message.type) {
        case 'requestSample': {
          try {
            const sampleUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'sampleData.json');
            const stat = await vscode.workspace.fs.stat(sampleUri);
            if (stat) {
              const sample = await vscode.workspace.fs.readFile(sampleUri);
              const text = decodeUtf8(sample);
              panel.webview.postMessage({ type: 'sampleData', payload: JSON.parse(text) });
            }
          } catch {
            // sample file optional: ignore if missing
          }
          break;
        }
        case 'openFile': {
          const fsPath = String(message.fsPath ?? '');
          const u = vscode.Uri.file(fsPath);
          if (u.scheme !== 'file') throw new Error('Only file:// URIs allowed');
          if (!isInWorkspace(u)) throw new Error('Path not inside workspace');
          const doc = await vscode.workspace.openTextDocument(u);
          await vscode.window.showTextDocument(doc, { preview: false });
          break;
        }
        case 'openAt': {
          const fsPath = String(message.fsPath ?? '');
          const line = Math.max(0, Number(message.line ?? 0)|0);
          const col = Math.max(0, Number(message.col ?? 0)|0);
          const view = String(message.view || '').toLowerCase();
          const u = vscode.Uri.file(fsPath);
          if (u.scheme !== 'file') throw new Error('Only file:// URIs allowed');
          if (!isInWorkspace(u)) throw new Error('Path not inside workspace');
          const doc = await vscode.workspace.openTextDocument(u);
          const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: view==='beside' ? vscode.ViewColumn.Beside : undefined });
          const pos = new vscode.Position(Math.min(line, doc.lineCount-1), col);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          break;
        }
        case 'exportData': {
          const kind = String(message.kind || 'json');
          const suggestedName = String(message.suggestedName || `depviz-${Date.now()}.${kind}`);
          const blobBase64 = String(message.base64 || '');
          const filters: Record<string, string[]> =
            kind==='svg' ? { 'SVG': ['svg'] } :
            kind==='png' ? { 'PNG Image': ['png'] } :
            kind==='dv'  ? { 'DepViz Graph': ['dv','json'] } :
                           { 'JSON': ['json'] };
          const uri = await vscode.window.showSaveDialog({ filters, defaultUri: vscode.Uri.file(suggestedName) });
          if (!uri) break;
          const bytes = Buffer.from(blobBase64, 'base64');
          await vscode.workspace.fs.writeFile(uri, bytes);
          const label = kind==='dv' ? 'DV' : kind.toUpperCase();
          vscode.window.showInformationMessage(`DepViz: Exported ${label} to ${uri.fsPath}`);
          break;
        }
        case 'peekAt': {
          const fsPath = String(message.fsPath ?? '');
          const line = Math.max(0, Number(message.line ?? 0)|0);
          const col = Math.max(0, Number(message.col ?? 0)|0);
          const view = String(message.view || '').toLowerCase();
          const u = vscode.Uri.file(fsPath);
          if (u.scheme !== 'file') throw new Error('Only file:// URIs allowed');
          if (!isInWorkspace(u)) throw new Error('Path not inside workspace');
          const doc = await vscode.workspace.openTextDocument(u);
          const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: view==='beside' ? vscode.ViewColumn.Beside : undefined });
          const pos = new vscode.Position(Math.min(line, doc.lineCount-1), col);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          try { await vscode.commands.executeCommand('editor.action.referenceSearch.trigger'); } catch {}
          break;
        }
        case 'gotoDef': {
          const t = message.target || {};
          const name = String(t.name || '');
          const file = t.file ? String(t.file) : undefined;
          const view = String(message.view || '').toLowerCase();
          await gotoSymbol({ file, name }, /*peek*/ false, view==='beside');
          break;
        }
        case 'peekRefs': {
          const t = message.target || {};
          const name = String(t.name || '');
          const file = t.file ? String(t.file) : undefined;
          const view = String(message.view || '').toLowerCase();
          await gotoSymbol({ file, name }, /*peek*/ true, view==='beside');
          break;
        }
        case 'requestImportJson': {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, filters: { 'JSON': ['json'] } });
          if (!picked || !picked.length) break;
          const content = await vscode.workspace.fs.readFile(picked[0]);
          const text = decodeUtf8(content);
          try {
            const payload = JSON.parse(text);
            panel.webview.postMessage({ type: 'addArtifacts', payload });
          } catch (e:any) {
            vscode.window.showErrorMessage(`DepViz: Failed to import JSON: ${e?.message ?? e}`);
          }
          break;
        }
        case 'requestImportSnapshot': {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            filters: { 'DepViz Graph': ['dv','json'] }
          });
          if (!picked || !picked.length) break;
          try {
            const content = await vscode.workspace.fs.readFile(picked[0]);
            const text = decodeUtf8(content);
            const snap = JSON.parse(text);
            panel.webview.postMessage({ type: 'loadSnapshot', payload: snap });
            vscode.window.showInformationMessage(`DepViz: Loaded snapshot ${picked[0].fsPath}`);
          } catch (e:any) {
            vscode.window.showErrorMessage(`DepViz: Failed to load snapshot: ${e?.message ?? e}`);
          }
          break;
        }
        case 'droppedUris': {
          const items: string[] = Array.isArray(message.items) ? message.items : [];
          const uris: vscode.Uri[] = [];
          for (const raw of items) {
            try { uris.push(toSafeFileUri(raw)); } catch {}
          }
          const cfg = vscode.workspace.getConfiguration('depviz');
          const maxFiles = cfg.get<number>('maxFiles') ?? 2000;
          await importMany(uris, panel, context, maxFiles);
          break;
        }
        case 'clearCanvas': {
          totals = { modules: 0, funcs: 0 };
          try { (FINGERPRINTS as any as Map<string,string>).clear(); } catch {}
          updateStatusBar();
          break;
        }
        case 'evictFingerprint': {
          try {
            const fsPath = String(message.fsPath || '');
            if (fsPath) {
              const key = normalizePath(fsPath);
              (FINGERPRINTS as any as Map<string,string>).delete(key);
            }
          } catch {}
          break;
        }
        case 'impactSummary': {
          const p = message.payload || {};
          const dir = p.dir === 'in' ? 'inbound' : 'outbound';
          const counts = p.counts || { modules:0, classes:0, funcs:0, edges:0 };
          const msg = `Impact slice (${dir}): ${counts.modules} files, ${counts.classes} classes, ${counts.funcs} funcs, ${counts.edges} edges.`;
          const pick = await vscode.window.showInformationMessage(msg, 'Copy files');
          if (pick === 'Copy files') {
            const list = (p.files || []).join('\n');
            await vscode.env.clipboard.writeText(list);
            vscode.window.showInformationMessage(`Copied ${(p.files || []).length} file path(s).`);
          }
          break;
        }
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`DepViz error: ${err?.message ?? err}`);
    }
  });

  return panel;
}

function isInWorkspace(uri: vscode.Uri): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const filePath = normalizePath(uri.fsPath);
  return folders.some(f => {
    const base = normalizePath(f.uri.fsPath).replace(/\/+$/, '');
    const withSlash = base.endsWith('/') ? base : base + '/';
    return filePath === base || filePath.startsWith(withSlash);
  });
}
function normalizePath(p: string) { return toPosixCore(p); }

function toSafeFileUri(input: string): vscode.Uri {
  const looksLikeUri = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input);
  if (looksLikeUri) {
    const u = vscode.Uri.parse(input);
    if (u.scheme !== 'file') throw new Error('Non-file scheme rejected');
    return u;
  }
  return vscode.Uri.file(input);
}

async function importUri(uri: vscode.Uri, panel: vscode.WebviewPanel, _context: vscode.ExtensionContext, token?: vscode.CancellationToken) {
  try {
    if (token?.isCancellationRequested) return;
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      const children = await vscode.workspace.fs.readDirectory(uri);
      for (const [name] of children) {
        if (SKIP_DIRS.has(name)) continue;
        await importUri(vscode.Uri.joinPath(uri, name), panel, _context, token);
      }
    } else {
      if (stat.size && stat.size > currentMaxFileSize()) {
        onceWarn('skip:large', `DepViz: skipped large file (${uri.fsPath})`);
        return;
      }
      const ext = extOf(uri.path);
      if (SKIP_EXTS.has(ext)) return;
      const adapter = pickByExt(ext);
      if (!adapter) return; // unsupported lang → skip quietly

      const content = await vscode.workspace.fs.readFile(uri);
      const text = decodeUtf8(content);

      // fingerprint skip (mark as imported only after a successful post to the webview)
      let fp: string | null = null;
      let fpKey: string | null = null;
      try {
        fp = hash(text);
        fpKey = normalizePath(uri.fsPath);
        const prev = (FINGERPRINTS as any as Map<string,string>).get(fpKey);
        if (prev === fp) return;
      } catch {}

      // 1) parse structs + bare calls
      const facts = await adapter.parseStructs(text, uri.fsPath);
      // Optional: surface minimal-parse fallback to the user
      try {
        const onlyModule =
          facts.structs.length === 1 && facts.structs[0].kind === 'module';
        if (onlyModule) {
          const extShown = ext || '';
          onceWarn(`fallback:${uri.fsPath}`, `DepViz: using fallback parser for ${extShown} (${uri.fsPath})`);
        }
      } catch {}
      const nodes: GraphNode[] = facts.structs;
      // Pretty module labels: workspace-relative + middle-ellipsis
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const rel = vscode.workspace.asRelativePath(uri, false);
      const relPosix = rel.replace(/\\/g, '/');
      const pretty = shortPath(relPosix, 48); // tweak width to taste
      for (const n of nodes) {
        if (n.kind === 'module') {
          n.label = pretty;         // what we render
          n.source = facts.structs.find(x=>x.id===n.id)?.source || n.source; // keep
          // keep fsPath as-is for openAt actions
        }
      }
      // 2) resolve imports using adapter (AST/compiler) if available; edge confidence accordingly
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const importMap = adapter.resolveImports ? await adapter.resolveImports(facts, workspaceRoot) : new Map<string,string>();

      // Build import edges (module→module) only if resolved path matches a known module label (hash strategy same as before)
      const mod = nodes.find(n=>n.kind==='module');
      const edges: GraphEdge[] = [];
      if (mod) {
        for (const [_spec, resolved] of importMap.entries()) {
          if (!resolved) continue;
          // Use absolute-posix path for module-id hashing to match adapters
          const toId = `mod_${hash(normalizePath(resolved))}`;
          edges.push({ from: mod.id, to: toId, type: 'import', confidence: 'ast' });
        }
      }

      function shortPath(p: string, maxLen = 48): string {
        if (p.length <= maxLen) return p;
        const parts = p.split('/');
        if (parts.length <= 3) return p;
        const head = parts[0];
        const tail = parts.slice(-2).join('/');
        const mid = '…';
        let out = `${head}/${mid}/${tail}`;
        if (out.length <= maxLen) return out;
        // tighten further by dropping more middle segments
        let i = 1, j = parts.length - 3;
        while (i < j && out.length > maxLen) {
          i++;
          out = `${parts.slice(0, i).join('/')}/${mid}/${tail}`;
        }
        return out.length <= maxLen ? out : `${mid}/${tail}`;
      }

      // 3) resolve calls (local first). Adapter produces call edges; mark confidence from adapter.
      if (adapter.resolveCalls) {
        const callEdges = await adapter.resolveCalls(facts, nodes, importMap, workspaceRoot);
        for (const ce of callEdges) {
          edges.push({ ...ce } as GraphEdge);
        }
      }

      // Dedupe edges
      const seen = new Set<string>();
      const dedup: GraphEdge[] = [];
      for (const e of edges) {
        const k = makeEdgeKey(e);
        if (seen.has(k)) continue;
        seen.add(k); dedup.push(e);
      }
      indexModuleNodes(nodes);

      try {
        const mod = nodes.find(n => n.kind==='module');
        if (mod && facts.callsByFuncId) {
          for (const [fromFnId, bareNames] of facts.callsByFuncId) {
            for (const bare of bareNames) {

              const unique = uniqueGlobalMatch(bare, mod.id);
              if (unique) {
                const e: GraphEdge = { from: fromFnId, to: unique.id, type: 'call', confidence: 'ast' /* or 'regex' if you prefer */ };
                const k = makeEdgeKey(e);
                if (!seen.has(k)) { seen.add(k); dedup.push(e); }
              }
            }
          }
        }
      } catch {}

      panel.webview.postMessage({ type: 'addArtifacts', payload: { nodes, edges: dedup } });
      totals.modules += nodes.filter(n=>n.kind==='module').length;
      totals.funcs   += nodes.filter(n=>n.kind==='func').length;
      updateStatusBar();
      try {
        if (fpKey && fp) (FINGERPRINTS as any as Map<string,string>).set(fpKey, fp);
      } catch {}
    }
  } catch (e:any) {
    dError(`importUri failed: ${uri.fsPath}: ${e?.message ?? e}`);
  }
}
function maxBytes(): number {
  const mb = vscode.workspace.getConfiguration('depviz').get<number>('maxFileSizeMB') ?? 1.5;
  return Math.max(1, mb) * 1_000_000;
}

function currentMaxFileSize(): number { return maxBytes(); }
const FINGERPRINTS: Map<string, string> = new Map();
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '.env',
  'dist', 'out', 'build', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox'
]);
const SKIP_EXTS = new Set([
  '.min.js', '.map', '.lock',
  // images & icons
  '.png','.jpg','.jpeg','.gif','.svg','.ico',
  '.webp','.bmp','.tif','.tiff','.apng','.avif',
  // docs/archives/binaries
  '.pdf','.zip',
  '.pyc','.pyo','.whl','.so','.dll',
  '.class'
]);

function extOf(p: string) { const m = /\.([a-z0-9_.-]+)$/i.exec(p); return m ? '.' + m[1].toLowerCase() : ''; }

async function importMany(uris: vscode.Uri[], panel: vscode.WebviewPanel, context: vscode.ExtensionContext, hardCap: number) {
  if (!uris.length) return;
  const cfg = vscode.workspace.getConfiguration('depviz');
  const include = (cfg.get<string[]>('includeGlobs') ?? ['**/*']).filter(Boolean);
  const exclude = (cfg.get<string[]>('excludeGlobs') ?? ['**/.git/**','**/node_modules/**','**/__pycache__/**']).filter(Boolean);
  const maxFiles = Math.max(1, hardCap | 0);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'DepViz: Importing...', cancellable: true },
    async (progress, token) => {
      // Prefer VS Code’s fast index (respects .gitignore); fallback to DFS if needed
      const files = await findFilesFromRoots(uris, include, exclude, maxFiles);
      const capped = files.slice(0, maxFiles);
      let done = 0;
      const batch = 8; // polite concurrency
      for (let i = 0; i < capped.length; i += batch) {
        if (token.isCancellationRequested) break;
        await Promise.all(
          capped.slice(i, i + batch).map(u => importUri(u, panel, context, token))
        );
        done = Math.min(capped.length, i + batch);
        progress.report({ message: `${done}/${capped.length}` });
      }
      vscode.window.showInformationMessage(`DepViz: Imported ${done} file(s).`);
    });
}

async function findFilesFromRoots(roots: vscode.Uri[], includeGlobs: string[], excludeGlobs: string[], maxFiles: number): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folderSet = new Set(folders.map(f => f.uri.toString()));

  // If user gave us files directly, take them as-is
  const files = roots.filter(u => !u.path.endsWith('/') && !u.path.endsWith('\\'));
  out.push(...files);

  // For directories or workspace folders, use findFiles with RelativePattern
  const dirs = roots.filter(u => !files.includes(u));
  for (const d of dirs) {
    let baseFolder = folders.find(f => d.toString().startsWith(f.uri.toString()));
    if (!baseFolder && folderSet.size === 1) {
      baseFolder = folders[0];
    }
    const base = baseFolder ? new RelativePattern(baseFolder, '**/*') : undefined;
    for (const g of includeGlobs) {
      const incl = baseFolder ? new RelativePattern(baseFolder, g) : g;
      const excl = excludeGlobs.length ? `{${excludeGlobs.join(',')}}` : undefined;
      const found = await vscode.workspace.findFiles(incl as any, excl, Math.max(1, maxFiles - out.length));
      // Filter to stay under the directory root (when not full-workspace)
      const scoped = base ? found.filter(u => u.fsPath.toLowerCase().startsWith(d.fsPath.toLowerCase())) : found;
      for (const u of scoped) {
        if (out.length >= maxFiles) break;
        out.push(u);
      }
      if (out.length >= maxFiles) break;
    }
    if (out.length >= maxFiles) break;
  }
  return out;
}

function updateStatusBar() {
  if (statusBar) {
    statusBar.text = `DepViz: $(graph) ${totals.modules} mod | ${totals.funcs} fn`;
    statusBar.tooltip = 'Click to reopen DepViz';
  }
}

// --- tiny helper to make a nonce
function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * Math.random() * chars.length));
  return s;
}

/** Very light parser… (unchanged except: NO ghost modules for imports) */
function parseFile(uri: vscode.Uri, text: string) {
  const fileLabel = vscode.workspace.asRelativePath(uri, false);   // for display
  const moduleLabelKey = normPosix(uri.fsPath);
  const moduleId = `mod_${hash(moduleLabelKey)}`;

  const nodes: any[] = [{ id: moduleId, kind: 'module', label: fileLabel, fsPath: uri.fsPath, source: text }];
  const edges: any[] = [];

  const lines = text.split(/\r?\n/);

  type Fn = { id: string; name: string; start: number; end: number; col: number; parent?: string };
  const fns: Fn[] = [];
  const pyDef = /^\s*def\s+([a-zA-Z_\d]+)\s*\(/;
  const pyClass = /^\s*class\s+([A-Za-z_\d]+)\s*[:(]/;
  const tsDef = /^\s*(?:export\s+)?function\s+([a-zA-Z_\d]+)\s*\(/;
  const tsVarFn = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_\d]+)\s*=\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>)/;

  // Naive class + method detection for Python so classes appear even without LSP
  const classIds = new Map<string,string>();
  const classStack: Array<{ name: string; indent: number; id: string }> = [];
  for (let i=0;i<lines.length;i++){
    const L = lines[i];
    const indent = (L.match(/^\s*/)?.[0]?.length) || 0;
    // Maintain class stack by indentation
    while (classStack.length && indent <= classStack[classStack.length-1].indent) {
      classStack.pop();
    }
    const cm = pyClass.exec(L);
    if (cm) {
      const clsName = cm[1];
      const clsId = `cls_${hash(fileLabel + ':' + clsName)}`;
      classIds.set(clsName, clsId);
      classStack.push({ name: clsName, indent, id: clsId });
      nodes.push({ id: clsId, kind: 'class', label: `class ${clsName}`, parent: moduleId, docked: true, snippet: lines.slice(i, Math.min(lines.length, i+20)).join('\n'), fsPath: uri.fsPath, range: { line: i, col: indent } });
      continue;
    }
    const m1 = pyDef.exec(L) || tsDef.exec(L) || tsVarFn.exec(L);
    if (m1) {
      const name = m1[1] || m1[2] || m1[3];
      const id = `fn_${hash(fileLabel + ':' + name + ':' + i)}`;
      const col = indent;
      // If inside a Python class, nest under it and qualify name
      let parent: string | undefined;
      let labelName = name;
      if (classStack.length) {
        const top = classStack[classStack.length-1];
        parent = top.id;
        labelName = `${top.name}.${name}`;
      }
      fns.push({ id, name: labelName, start: i, end: lines.length, col, parent });
    }
  }
  for (let i=0;i<fns.length-1;i++) fns[i].end = fns[i+1].start - 1;

  for (const fn of fns) {
    nodes.push({
      id: fn.id, kind: 'func', label: `def ${fn.name}()`, parent: fn.parent || moduleId, docked: true,
      snippet: snippetFrom(lines, fn.start), fsPath: uri.fsPath, range: { line: fn.start, col: fn.col }
    });
  }

  const nameToId = new Map<string,string>();
  const callRegex = new Map<string, RegExp>();
  const wcr = (t: string) => new RegExp(String.raw`\b${escapeReg(t)}\s*\(`);
  const bareTokOf = (s: string) => (s.includes('.') ? s.split('.').pop() || s : s);
  for (const fn of fns) {
    nameToId.set(fn.name, fn.id);
    callRegex.set(fn.name, wcr(fn.name));
  }

  for (const fn of fns) {
    const body = stripStringsAndComments(lines.slice(fn.start, fn.end + 1).join('\n'));
    for (const [calleeName, calleeId] of nameToId) {
      if (calleeName === fn.name) continue;
    const full = callRegex.get(calleeName) ?? wcr(calleeName);
    const bare = wcr(bareTokOf(calleeName));
      if (full.test(body) || bare.test(body)) edges.push({ from: fn.id, to: calleeId, type: 'call', confidence: 'regex' });
    }
  }

  const T = stripStringsAndComments(text);
  const imp = /^(?:from\s+([\w\.]+)\s+import\s+[\w\*,\s\(\)]+|import\s+([\w\.]+)(?:\s+as\s+\w+)?)/gm;
  const impTs = /(?:^|\n)\s*(?:import\s+(?:.+?)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = imp.exec(T)) !== null) {
    const target = (m[1] ?? m[2] ?? '').trim();
    if (!target) continue;
    const label = resolveImportLabelByText(fileLabel, target, 'py');
    const to = label ? `mod_${hash(label)}` : `mod_${hash(target)}`;
    // only emit the edge; do NOT create a placeholder node
    edges.push({ from: moduleId, to, type: 'import', confidence: 'regex' });
  }
  while ((m = impTs.exec(T)) !== null) {
    const target = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!target) continue;
    const label = resolveImportLabelByText(fileLabel, target, 'ts');
    const to = label ? `mod_${hash(label)}` : `mod_${hash(target)}`;
    // only emit the edge; do NOT create a placeholder node
    edges.push({ from: moduleId, to, type: 'import', confidence: 'regex' });
  }

  return { nodes, edges };
}

function snippetFrom(lines: string[], start: number) { const end = Math.min(lines.length, start + 20); return lines.slice(start, end).join('\n'); }

// Heuristic: map import specifiers to our module labels (workspace-relative posix paths)
function resolveImportLabelByText(fromLabel: string, spec: string, lang: 'ts'|'py'): string | null {
  try {
    const posixFrom = fromLabel.replace(/\\/g,'/');
    const baseDir = posixFrom.includes('/') ? posixFrom.slice(0, posixFrom.lastIndexOf('/')) : '';
    const rel = (p: string) => normPosix((baseDir ? baseDir + '/' : '') + p);
    if (lang === 'ts') {
      if (spec.startsWith('.')) {
        const core = rel(spec);
        if (/\.(ts|tsx|js|jsx)$/i.test(core)) return core;
        const cands = [core + '.ts', core + '.tsx', core + '.js', core + '.jsx', core + '/index.ts', core + '/index.tsx', core + '/index.js', core + '/index.jsx'];
        return cands[0];
      }
      if (spec.startsWith('/')) {
        const s = spec.replace(/^\/+/, '');
        const core = normPosix(s);
        return /\.(ts|tsx|js|jsx)$/i.test(core) ? core : (core + '.ts');
      }
      return null; // bare specifier requires tsconfig paths; skip
    } else {
      // Python
      if (spec.startsWith('.')) {
        const up = spec.match(/^\.+/); const dots = up ? up[0].length : 0;
        const rest = spec.slice(dots).replace(/^\./,'');
        // Python semantics: "." = current (pop 0), ".." = parent (pop 1), "..." = grandparent (pop 2), etc.
        const pops = Math.max(0, dots - 1);
        let parts = baseDir ? baseDir.split('/') : [];
        parts = parts.slice(0, Math.max(0, parts.length - pops));
        const core = normPosix(parts.join('/') + (rest ? ('/' + rest.replace(/\./g,'/')) : ''));
        const cands = [core + '.py', core + '/__init__.py'];
        return cands[0];
      }
      const core = normPosix(spec.replace(/\./g, '/'));
      const cands = [core + '.py', core + '/__init__.py'];
      return cands[0];
    }
  } catch {}
  return null;
}

function getHtml(panel: vscode.WebviewPanel, deps: {
  scriptUris: string[];
  styleUri: string;
  dataUri: string;
  codiconUri: string;
  iconDark: string;
  iconLight: string;
}) {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${panel.webview.cspSource} blob:`,
    `style-src ${panel.webview.cspSource}`,
    `font-src ${panel.webview.cspSource}`,
    `script-src 'nonce-${nonce}' ${panel.webview.cspSource}`,
    // allow fetch() to webview resources (sampleData.json) + VS Code messaging
    `connect-src ${panel.webview.cspSource}`
  ].join('; ');
  return `
  <!DOCTYPE html>
  <html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${deps.styleUri}" rel="stylesheet" />
    <link href="${deps.codiconUri}" rel="stylesheet" />
    <title>DepViz</title>
  </head>
  <body>
    <div id="toolbar" role="toolbar" aria-label="DepViz toolbar">
      <img id="themeToggle" title="Toggle theme" width="18" height="18"
           src="${deps.iconLight}" data-icon-dark="${deps.iconDark}" data-icon-light="${deps.iconLight}" />
      <button id="btnHelp" title="Shortcuts (?)">?</button>
    </div>
    <div id="canvasWrapper">
      <svg id="canvas" tabindex="0" aria-label="dependency canvas" role="application"></svg>
    </div>
    <div id="help" hidden>
      <div class="hcard">
        <b>Shortcuts</b>
        <div>Ctrl/Cmd+Shift+A – Arrange by folders</div>
        <div>Ctrl/Cmd+Shift+B – Balanced grid</div>
        <div>Ctrl/Cmd+/ – Toggle help</div>
        <div>Ctrl/Cmd+Shift+S – Clear impact slice</div>
        <div>Drag files/folders to import</div>
        <div>Click legend to toggle edge types</div>
      </div>
    </div>
    <div id="legend"></div>

    <script nonce="${nonce}">
      window.DEPVIZ = { DATA_URI: "${deps.dataUri}" };
      window.vscode = acquireVsCodeApi();
      window.DATA_URI = window.DEPVIZ.DATA_URI;
    </script>

    ${deps.scriptUris.map(u=>`<script nonce="${nonce}" src="${u}"></script>`).join("\n    ")}
  </body>
  </html>`;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const TD: any = (globalThis as any).TextDecoder;
    if (TD) return new TD('utf-8').decode(bytes);
  } catch {}
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes as any).toString('utf8');
    }
  } catch {}
  throw new Error('UTF-8 decode not supported in this environment');
}

// -------- Archflow-like: go to symbol + peek refs with beside column
async function gotoSymbol(target: { file?: string; name: string }, peek: boolean, beside: boolean) {
  try {
    if (!target || !target.name) return;
    // Prefer in-file, else workspace symbol, else regex scan
    const loc = await resolveSymbolLocation(target);
    if (!loc) { vscode.window.showWarningMessage(`DepViz: couldn't find "${target.name}".`); return; }
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: beside ? vscode.ViewColumn.Beside : undefined, preserveFocus: false });
    const defLine = loc.range.start.line;
    const lineText = doc.lineAt(defLine).text;
    const nameRe = new RegExp(`\\b${escapeReg(target.name)}\\b`);
    const m = nameRe.exec(lineText);
    if (peek && m) {
      const pos = new vscode.Position(defLine, m.index);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(new vscode.Position(defLine, 0), new vscode.Position(defLine, Math.max(0, lineText.length))), vscode.TextEditorRevealType.InCenter);
    } else {
      const lineRange = new vscode.Range(new vscode.Position(defLine, 0), new vscode.Position(defLine, Math.max(0, lineText.length)));
      editor.selection = new vscode.Selection(lineRange.start, lineRange.end);
      editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);
    }
    if (peek) {
      try { await vscode.commands.executeCommand('editor.action.referenceSearch.trigger'); } catch {}
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(e?.message || String(e));
  }
}

async function resolveSymbolLocation(target: { file?: string; name: string }): Promise<vscode.Location | null> {
  const name = target.name;
  if (target.file) {
    const uri = vscode.Uri.file(target.file);
    const inFile = await lookupInFile(uri, name);
    if (inFile) return inFile;
  }
  const inWs = await lookupInWorkspace(name);
  if (inWs) return inWs;
  if (target.file) {
    const uri = vscode.Uri.file(target.file);
    const scan = await regexScan(uri, name);
    if (scan) return scan;
  }
  return null;
}

async function lookupInFile(uri: vscode.Uri, name: string): Promise<vscode.Location | null> {
  const res = await vscode.commands.executeCommand<any>('vscode.executeDocumentSymbolProvider', uri);
  const symbols: vscode.DocumentSymbol[] = Array.isArray(res) ? res : [];
  const flat: vscode.DocumentSymbol[] = [];
  const walk = (s: vscode.DocumentSymbol) => { flat.push(s); s.children?.forEach(walk); };
  symbols.forEach(walk);
  const last = (name || '').split('.').pop() || name;
  let cand = flat.find(s => s.name === name)
          || flat.find(s => s.name === last)
          || flat.find(s => (s.name.split('.').pop() || s.name) === last)
          || flat.find(s => s.name.toLowerCase() === last.toLowerCase());
  return cand ? new vscode.Location(uri, cand.selectionRange ?? cand.range) : null;
}

async function lookupInWorkspace(name: string): Promise<vscode.Location | null> {
  const res = await vscode.commands.executeCommand<any>('vscode.executeWorkspaceSymbolProvider', name);
  const infos: vscode.SymbolInformation[] = Array.isArray(res) ? res : [];
  const last = (name || '').split('.').pop() || name;

  // only functions/methods/constructors. dump vars/fields/etc.
  const FN = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
  const fns = infos.filter(s => FN.has(s.kind));

  const pick =
      fns.find(s => s.name === name) ||
      fns.find(s => s.name === last) ||
      fns.find(s => (s.name.split('.').pop() || s.name) === last) ||
      fns.find(s => s.name.toLowerCase() === last.toLowerCase()) ||
      null;
  return pick ? pick.location : null;
}

async function regexScan(uri: vscode.Uri, name: string): Promise<vscode.Location | null> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    // prefer call sites first: NAME(
    let m = new RegExp(String.raw`\b${escapeReg(name)}\s*\(`, 'g').exec(text);
    if (m) {
      const pos = doc.positionAt(m.index);
      return new vscode.Location(uri, new vscode.Range(pos, pos.translate(0, name.length)));
    }
    // then definitions in common langs
    const defs = [
      new RegExp(String.raw`^\s*def\s+${escapeReg(name)}\s*\(`, 'm'),                      // py
      new RegExp(String.raw`^\s*(?:export\s+)?function\s+${escapeReg(name)}\s*\(`, 'm'),   // ts/js
      new RegExp(String.raw`^\s*(?:public|private|protected|static\s+)*${escapeReg(name)}\s*\(`, 'm') // ts class method
    ];
    for (const re of defs) {
      m = re.exec(text);
      if (m) {
        const pos = doc.positionAt(m.index);
        return new vscode.Location(uri, new vscode.Range(pos, pos.translate(0, name.length)));
      }
    }
  } catch {}
  return null;
}

function escapeReg(s: string){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
