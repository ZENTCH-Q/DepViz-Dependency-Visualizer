// src/document/dvProvider.ts
import * as vscode from 'vscode';
import { DvDocument } from './dvDocument';
import { ImportService } from '../services/import/importService';
import { getCustomEditorHtml } from '../services/panel/html';
import { Totals } from '../shared/types';
import { GotoSymbolFn } from '../services/navigation/gotoSymbol';
import { getWebviewAssets } from '../services/panel/assets';
import { WebviewController } from '../services/webview/WebviewController';
import type { WebviewControllerOptions } from '../services/webview/WebviewController';

interface ProviderDeps {
  context: vscode.ExtensionContext;
  importService: ImportService;
  totals: Totals;
  updateStatusBar: () => void;
  gotoSymbol: GotoSymbolFn;
}

export class DepvizDvProvider implements vscode.CustomEditorProvider<DvDocument> {
  private readonly onDidChangeCustomDocumentEmitter =
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DvDocument>>();
  public readonly onDidChangeCustomDocument = this.onDidChangeCustomDocumentEmitter.event;
  private readonly docSubscriptions = new WeakMap<DvDocument, vscode.Disposable>();

  constructor(private readonly deps: ProviderDeps) {}

  async openCustomDocument(uri: vscode.Uri): Promise<DvDocument> {
    const doc = await DvDocument.create(uri);
    const sub = doc.onDidChangeCustomDocument(edit => {
      this.onDidChangeCustomDocumentEmitter.fire({
        document: doc,
        ...edit
      });
    });
    this.docSubscriptions.set(doc, sub);
    return doc;
  }

  async saveCustomDocument(document: DvDocument, token: vscode.CancellationToken): Promise<void> {
    return document.save(token);
  }

  async saveCustomDocumentAs(document: DvDocument, target: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
    return document.saveAs(target, token);
  }

  async revertCustomDocument(document: DvDocument, token: vscode.CancellationToken): Promise<void> {
    return document.revert(token);
  }

  async backupCustomDocument(document: DvDocument, context: vscode.CustomDocumentBackupContext, token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, token);
  }

  async resolveCustomEditor(document: DvDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.deps.context.extensionUri]
    };

    const assets = getWebviewAssets(this.deps.context, panel.webview);

    panel.webview.html = getCustomEditorHtml(panel, assets);

    try {
      const snap = JSON.parse(document.getText());
      panel.webview.postMessage({ type: 'loadSnapshot', payload: snap });
    } catch (err: any) {
      if (err?.message) {
        vscode.window.showErrorMessage(`DepViz: invalid .dv (${err.message})`);
      }
    }

    const opts: WebviewControllerOptions = {
      context: this.deps.context,
      importService: this.deps.importService,
      totals: this.deps.totals,
      updateStatusBar: this.deps.updateStatusBar,
      gotoSymbol: this.deps.gotoSymbol,
      document,
      allowImpactSummary: false
    };
    const controller = new WebviewController(panel, opts);
    controller.attach();

    panel.onDidDispose(() => {
      this.docSubscriptions.get(document)?.dispose();
      controller.dispose();
    });
  }
}

