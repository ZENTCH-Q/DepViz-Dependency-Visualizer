// src/services/panel/panelManager.ts
import * as vscode from 'vscode';
import { ParseService } from '../parse/parseService';
import { ImportService } from '../import/importService';
import { registerWebviewMessageHandlers } from '../messaging/webviewMessageRouter';
import { getPanelHtml } from './html';
import { gotoSymbol, GotoSymbolFn } from '../navigation/gotoSymbol';
import { GraphArtifacts, Totals } from '../../shared/types';

export class PanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly totals: Totals = { modules: 0, funcs: 0 };
  private readonly parseService = new ParseService();
  private readonly importService: ImportService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'depviz.open';
    this.statusBar.text = `DepViz: $(graph) Ready`;
    this.statusBar.tooltip = 'Open DepViz';
    this.statusBar.show();

    this.importService = new ImportService(
      context,
      this.parseService,
      this.recordArtifacts,
      this.totals
    );
  }

  dispose(): void {
    this.panel?.dispose();
    this.statusBar.dispose();
  }

  getImportService(): ImportService {
    return this.importService;
  }

  getTotals(): Totals {
    return this.totals;
  }

  getStatusUpdater(): () => void {
    return () => this.updateStatusBar();
  }

  getActivePanel(): vscode.WebviewPanel | undefined {
    return this.panel;
  }

  getGotoSymbol(): GotoSymbolFn {
    return this.gotoSymbol;
  }

  openPanel(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      'depviz',
      'DepViz',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel = panel;

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });

    this.importService.resetFingerprints();
    this.totals.modules = 0;
    this.totals.funcs = 0;
    this.updateStatusBar();

    vscode.window.showInformationMessage(
      'DepViz opened. Import files to see something.',
      'Import...',
      'Load Sample'
    ).then(async pick => {
      if (pick === 'Import...') {
        vscode.commands.executeCommand('depviz.import');
      }
      if (pick === 'Load Sample') {
        panel.webview.postMessage({ type: 'requestSample' });
      }
    });

    const scriptStateUri   = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview-state.js'));
    const scriptUiUri      = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview-ui.js'));
    const scriptUri        = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'));
    const scriptGeomUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview-geom.js'));
    const scriptInteractUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview-interact.js'));
    const scriptArrangeUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview-arrange.js'));
    const scriptDataUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview-data.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'));
    const dataUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sampleData.json'));
    const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicon.css'));
    const iconDarkUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'depviz-dark.svg'));
    const iconLightUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'depviz-light.svg'));

    panel.webview.html = getPanelHtml(panel, {
      scriptUris: [
        scriptStateUri.toString(),
        scriptUiUri.toString(),
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

    registerWebviewMessageHandlers(panel, {
      context: this.context,
      importService: this.importService,
      totals: this.totals,
      updateStatusBar: () => this.updateStatusBar(),
      gotoSymbol: this.gotoSymbol,
      allowSamples: true,
      allowImpactSummary: true
    });

    return panel;
  }

  private recordArtifacts = (artifacts: GraphArtifacts) => {
    this.totals.modules += (artifacts.nodes || []).filter(node => node.kind === 'module').length;
    this.totals.funcs += (artifacts.nodes || []).filter(node => node.kind === 'func').length;
    this.updateStatusBar();
  };

  private gotoSymbol: GotoSymbolFn = async (target, peek, beside) => {
    await gotoSymbol(target, peek, beside);
  };

  private updateStatusBar() {
    this.statusBar.text = `DepViz: $(graph) ${this.totals.modules} mod | ${this.totals.funcs} fn`;
    this.statusBar.tooltip = 'Click to reopen DepViz';
  }
}
