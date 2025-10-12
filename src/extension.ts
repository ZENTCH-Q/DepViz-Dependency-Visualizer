// src/extension.ts
import * as vscode from 'vscode';
import { PanelManager } from './services/panel/panelManager';
import { DepvizDvProvider } from './document/dvProvider';
import { isInWorkspace } from './shared/workspace';

let panelManager: PanelManager | undefined;
let importDebounce: NodeJS.Timeout | undefined;

// NEW: per-file debounce for live in-memory updates
const liveDebounce = new Map<string, NodeJS.Timeout>();

export function activate(context: vscode.ExtensionContext) {
  panelManager = new PanelManager(context);

  const openCmd = vscode.commands.registerCommand('depviz.open', () => {
    panelManager?.openPanel();
  });

  const importCmd = vscode.commands.registerCommand('depviz.import', async (uri?: vscode.Uri) => {
    if (!panelManager) {
      return;
    }
    const panel = panelManager.openPanel();
    const importService = panelManager.getImportService();
    const cfg = vscode.workspace.getConfiguration('depviz');
    const maxFiles = cfg.get<number>('maxFiles') ?? 2000;

    if (!uri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: 'Import to DepViz'
      });
      if (!picked) {
        return;
      }
      await importService.importMany(picked, panel, maxFiles);
    } else {
      await importService.importMany([uri], panel, maxFiles);
    }
  });

  const importActive = vscode.commands.registerCommand('depviz.importActive', async () => {
    if (!panelManager) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return vscode.window.showInformationMessage('DepViz: Open a file first.');
    }
    const panel = panelManager.openPanel();
    const cfg = vscode.workspace.getConfiguration('depviz');
    const maxFiles = cfg.get<number>('maxFiles') ?? 500;
    await panelManager.getImportService().importMany([editor.document.uri], panel, maxFiles);
  });

  // Diagnose LSP for the active file
  const diagLsp = vscode.commands.registerCommand('depviz.diagnoseLsp', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return vscode.window.showInformationMessage('DepViz: Open a file to diagnose.');
    const uri = ed.document.uri;
    const lang = ed.document.languageId;
    const res = await vscode.commands.executeCommand<any>('vscode.executeDocumentSymbolProvider', uri);
    const count = Array.isArray(res) ? res.length : 0;
    // try call hierarchy quickly
    let chOk = 'Unknown';
    try { await vscode.commands.executeCommand('vscode.prepareCallHierarchy', uri, new vscode.Position(0,0)); chOk = 'Yes'; }
    catch { chOk = 'No'; }
    const details = [
      `Language: ${lang}`,
      `Symbols returned: ${count}`,
      `Call Hierarchy: ${chOk}`,
      count === 0 ? 'No symbols. Is the language extension enabled?' : 'Looks good.'
    ].join(' • ');
    vscode.window.showInformationMessage(`DepViz: ${details}`, 'Open Extensions').then(p => {
      if (p === 'Open Extensions') vscode.commands.executeCommand('workbench.view.extensions');
    });
  });

  const provider = new DepvizDvProvider({
    context,
    importService: panelManager.getImportService(),
    totals: panelManager.getTotals(),
    updateStatusBar: panelManager.getStatusUpdater(),
    gotoSymbol: panelManager.getGotoSymbol()
  });

  const customEditor = vscode.window.registerCustomEditorProvider('depviz.graph', provider, {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: true
  });

  const onSave = vscode.workspace.onDidSaveTextDocument(async doc => {
    if (!panelManager) {
      return;
    }
    const panel = panelManager.getActivePanel();
    if (!panel) {
      return;
    }
    if (!isInWorkspace(doc.uri)) {
      return;
    }
    clearTimeout(importDebounce);
    importDebounce = setTimeout(() => {
      panelManager?.getImportService().importUri(doc.uri, panel).catch(() => {});
    }, 250);
  });

  // NEW: live update from in-memory edits (debounced)
  const onChange = vscode.workspace.onDidChangeTextDocument(e => {
    try {
      const cfg = vscode.workspace.getConfiguration('depviz');
      const liveEnabled = cfg.get<boolean>('liveUpdate', true); // default on
      if (!liveEnabled) return;

      const panel = panelManager?.getActivePanel();
      if (!panel) return;
      if (!isInWorkspace(e.document.uri)) return;

      // Only run for "real" files
      if (e.document.uri.scheme !== 'file') return;

      const key = e.document.uri.fsPath;
      const prev = liveDebounce.get(key);
      if (prev) clearTimeout(prev);

      // modest debounce; keep this in sync with LSP responsiveness
      const handle = setTimeout(() => {
        panelManager?.getImportService()
          .importText(e.document.uri, e.document.getText(), panel)
          .catch(() => {});
      }, 400);

      liveDebounce.set(key, handle);
    } catch {
      // best-effort
    }
  });

  context.subscriptions.push(
    panelManager,
    openCmd,
    importCmd,
    importActive,
    diagLsp,
    customEditor,
    onSave,
    onChange // NEW
  );
}

export function deactivate() {
  panelManager?.dispose();
  panelManager = undefined;
}
