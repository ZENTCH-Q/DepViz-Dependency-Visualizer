// src/extension.ts
import * as vscode from 'vscode';
import { PanelManager } from './services/panel/panelManager';
import { DepvizDvProvider } from './document/dvProvider';
import { isInWorkspace } from './shared/workspace';

let panelManager: PanelManager | undefined;
let importDebounce: NodeJS.Timeout | undefined;

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
    const details = [
      `Language: ${lang}`,
      `Symbols returned: ${count}`,
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

  context.subscriptions.push(
    panelManager,
    openCmd,
    importCmd,
    importActive,
    diagLsp,
    customEditor,
    onSave
  );
}

export function deactivate() {
  panelManager?.dispose();
  panelManager = undefined;
}

