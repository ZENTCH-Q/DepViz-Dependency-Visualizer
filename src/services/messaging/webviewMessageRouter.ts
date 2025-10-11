// src/services/messaging/webviewMessageRouter.ts
import * as vscode from 'vscode';
import { ImportService } from '../import/importService';
import { Totals } from '../../shared/types';
import { isInWorkspace, toSafeFileUri } from '../../shared/workspace';
import { fromBase64 } from '../../shared/base64';
import { dec } from '../../shared/encoding';
import { DvDocument } from '../../document/dvDocument';
import { GotoSymbolFn } from '../navigation/gotoSymbol';

type ViewPreference = 'beside' | 'active';

interface HandlerDependencies {
  context: vscode.ExtensionContext;
  importService: ImportService;
  totals: Totals;
  updateStatusBar: () => void;
  gotoSymbol: GotoSymbolFn;
  allowSamples?: boolean;
  allowImpactSummary?: boolean;
  document?: DvDocument;
}

export function registerWebviewMessageHandlers(
  panel: vscode.WebviewPanel,
  deps: HandlerDependencies
): vscode.Disposable {
  const subscription = panel.webview.onDidReceiveMessage(async message => {
    try {
      const type = String(message?.type ?? '');
      switch (type) {
        case 'requestSample':
          if (deps.allowSamples) {
            await handleRequestSample(panel, deps.context);
          }
          break;
        case 'edit':
          if (deps.document) {
            const text = JSON.stringify(message.payload ?? {}, null, 2);
            deps.document.applyEdit(text, message.label || 'Graph change');
            // Optional autosave of the snapshot
            if (vscode.workspace.getConfiguration('depviz').get<boolean>('autoSaveSnapshot')) {
              const cts = new vscode.CancellationTokenSource();
              try {
                await deps.document.save(cts.token);
                vscode.window.setStatusBarMessage('DepViz: Snapshot autosaved', 1200);
              } finally {
                cts.dispose();
              }
            }
          }
          break;
        case 'saveSnapshot':
          if (deps.document) {
            await handleSaveSnapshot(deps.document, message?.payload);
          }
          break;
        case 'requestImportJson':
          await handleRequestImportJson(panel);
          break;
        case 'requestImportSnapshot':
          await handleRequestImportSnapshot(panel);
          break;
        case 'openFile':
          await handleOpenFile(
            String(message.fsPath ?? ''),
            String(message.view || '').toLowerCase() === 'beside' ? 'beside' : 'active'
          );
          break;
        case 'peekAt':
          await handleOpenAt(String(message.fsPath ?? ''), message, true);
          break;
        case 'openAt':
          await handleOpenAt(String(message.fsPath ?? ''), message, false);
          break;
        case 'exportData':
          await handleExportData(message);
          break;
        case 'droppedUris': {
          const items: string[] = Array.isArray(message.items) ? message.items : [];
          const uris: vscode.Uri[] = [];
          for (const raw of items) {
            try {
              uris.push(toSafeFileUri(raw));
            } catch {
              // ignore invalid drop target
            }
          }
          const cfg = vscode.workspace.getConfiguration('depviz');
          const maxFiles = cfg.get<number>('maxFiles') ?? 2000;
          await deps.importService.importMany(uris, panel, maxFiles);
          break;
        }
        case 'clearCanvas':
          deps.importService.resetFingerprints();
          deps.totals.modules = 0;
          deps.totals.funcs = 0;
          deps.updateStatusBar();
          break;
        case 'evictFingerprint': {
          const fsPath = String(message.fsPath || '');
          if (fsPath) {
            deps.importService.evictFingerprint(fsPath);
          }
          break;
        }
        case 'gotoDef':
        case 'peekRefs': {
          const target = message.target || {};
          const name = String(target.name || '');
          if (!name) {
            return;
          }
          const file = target.file ? String(target.file) : undefined;
          const view = String(message.view || '').toLowerCase();
          await deps.gotoSymbol({ file, name }, type === 'peekRefs', view === 'beside');
          break;
        }
        case 'impactSummary':
          if (deps.allowImpactSummary) {
            await handleImpactSummary(message);
          }
          break;
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`DepViz error: ${err?.message ?? err}`);
    }
  });

  return subscription;
}

async function handleRequestSample(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
  try {
    const sampleUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'sampleData.json');
    const stat = await vscode.workspace.fs.stat(sampleUri);
    if (!stat) {
      return;
    }
    const sample = await vscode.workspace.fs.readFile(sampleUri);
    const text = dec(sample);
    panel.webview.postMessage({ type: 'sampleData', payload: JSON.parse(text) });
  } catch {
    // optional asset, ignore errors
  }
}

async function handleSaveSnapshot(document: DvDocument, payload: unknown) {
  try {
    const snapshot = payload || {};
    const text = JSON.stringify(snapshot, null, 2);
    document.applyEdit(text, 'Save graph');
    const cts = new vscode.CancellationTokenSource();
    try {
      await document.save(cts.token);
    } finally {
      cts.dispose();
    }
    vscode.window.setStatusBarMessage('DepViz: Snapshot saved', 2000);
  } catch (err: any) {
    vscode.window.showErrorMessage(`DepViz: Save failed: ${err?.message ?? err}`);
  }
}

async function handleRequestImportJson(panel: vscode.WebviewPanel) {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    filters: { 'JSON': ['json'] }
  });
  if (!picked || !picked.length) {
    return;
  }
  const content = await vscode.workspace.fs.readFile(picked[0]);
  const text = dec(content);
  try {
    panel.webview.postMessage({ type: 'addArtifacts', payload: JSON.parse(text) });
  } catch (err: any) {
    vscode.window.showErrorMessage(`DepViz: Failed to import JSON: ${err?.message ?? err}`);
  }
}

async function handleRequestImportSnapshot(panel: vscode.WebviewPanel) {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    filters: { 'DepViz Graph': ['dv', 'json'] }
  });
  if (!picked || !picked.length) {
    return;
  }
  try {
    const content = await vscode.workspace.fs.readFile(picked[0]);
    const text = dec(content);
    panel.webview.postMessage({ type: 'loadSnapshot', payload: JSON.parse(text) });
    vscode.window.showInformationMessage(`DepViz: Loaded snapshot ${picked[0].fsPath}`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`DepViz: Failed to load snapshot: ${err?.message ?? err}`);
  }
}

async function handleOpenFile(fsPath: string, view: ViewPreference) {
  const uri = vscode.Uri.file(fsPath);
  if (uri.scheme !== 'file') {
    throw new Error('Only file:// URIs allowed');
  }
  if (!isInWorkspace(uri)) {
    throw new Error('Path not inside workspace');
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: view === 'beside' ? vscode.ViewColumn.Beside : undefined });
}

async function handleOpenAt(
  fsPath: string,
  message: any,
  peek: boolean
) {
  const line = Math.max(0, Number(message.line ?? 0) | 0);
  const col = Math.max(0, Number(message.col ?? 0) | 0);
  const view = String(message.view || '').toLowerCase();
  const uri = vscode.Uri.file(fsPath);
  if (uri.scheme !== 'file') {
    throw new Error('Only file:// URIs allowed');
  }
  if (!isInWorkspace(uri)) {
    throw new Error('Path not inside workspace');
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: view === 'beside' ? vscode.ViewColumn.Beside : undefined
  });
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  if (peek) {
    try {
      await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
    } catch {
      // command optional
    }
  }
}

async function handleExportData(message: any) {
  const kind = String(message.kind || 'json');
  const suggestedName = String(message.suggestedName || `depviz-${Date.now()}.${kind}`);
  const blobBase64 = String(message.base64 || '');
  const filters: Record<string, string[]> =
    kind === 'svg' ? { 'SVG': ['svg'] } :
    kind === 'png' ? { 'PNG Image': ['png'] } :
    kind === 'dv'  ? { 'DepViz Graph': ['dv', 'json'] } :
                     { 'JSON': ['json'] };
  const uri = await vscode.window.showSaveDialog({ filters, defaultUri: vscode.Uri.file(suggestedName) });
  if (!uri) {
    return;
  }
  const bytes = fromBase64(blobBase64);
  await vscode.workspace.fs.writeFile(uri, bytes);
  const label = kind === 'dv' ? 'DV' : kind.toUpperCase();
  vscode.window.showInformationMessage(`DepViz: Exported ${label} to ${uri.fsPath}`);
}

async function handleImpactSummary(message: any) {
  const payload = message.payload || {};
  const dir = payload.dir === 'in' ? 'inbound' : 'outbound';
  const counts = payload.counts || { modules: 0, classes: 0, funcs: 0, edges: 0 };
  const info =
    `Impact slice (${dir}): ${counts.modules} files, ${counts.classes} classes, ${counts.funcs} funcs, ${counts.edges} edges.`;
  const pick = await vscode.window.showInformationMessage(info, 'Copy files');
  if (pick === 'Copy files') {
    const list = (payload.files || []).join('\n');
    await vscode.env.clipboard.writeText(list);
    vscode.window.showInformationMessage(`Copied ${(payload.files || []).length} file path(s).`);
  }
}
