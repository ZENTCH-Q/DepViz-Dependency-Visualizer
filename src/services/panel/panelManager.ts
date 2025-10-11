// src/services/panel/panelManager.ts
import * as vscode from 'vscode';
import { ParseService } from '../parse/parseService';
import { ImportService } from '../import/importService';
import { getPanelHtml } from './html';
import { gotoSymbol, GotoSymbolFn } from '../navigation/gotoSymbol';
import { GraphArtifacts, Totals } from '../../shared/types';
import { getWebviewAssets } from './assets';
import { WebviewController } from '../webview/WebviewController';
import type { WebviewControllerOptions } from '../webview/WebviewController';

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
      'Import...'
    ).then(pick => {
      if (pick === 'Import...') vscode.commands.executeCommand('depviz.import');
    });

    const assets = getWebviewAssets(this.context, panel.webview);

    panel.webview.html = getPanelHtml(panel, assets);

    const opts: WebviewControllerOptions = {
      context: this.context,
      importService: this.importService,
      totals: this.totals,
      updateStatusBar: () => this.updateStatusBar(),
      gotoSymbol: this.gotoSymbol,
      allowSamples: false,
      allowImpactSummary: true
    };
    const controller = new WebviewController(panel, opts);
    controller.attach();

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
    const md = new vscode.MarkdownString([
      '**DepViz**',
      '',
      `• Modules: ${this.totals.modules}`,
      `• Functions: ${this.totals.funcs}`,
      '',
      '_Click to open canvas. Use **DepViz: Import Active File** to add the current editor._'
    ].join('\n'));
    md.isTrusted = true;
    this.statusBar.tooltip = md;
  }
}
