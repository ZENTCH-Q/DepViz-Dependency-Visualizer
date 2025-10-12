import * as vscode from 'vscode';
import { ImportService } from '../import/importService';
import { registerWebviewMessageHandlers } from '../messaging/webviewMessageRouter';
import { Totals } from '../../shared/types';
import { GotoSymbolFn } from '../navigation/gotoSymbol';
import { DvDocument } from '../../document/dvDocument';
import type { WebviewOutbound } from '../../shared/messages';

export interface WebviewControllerOptions {
  context: vscode.ExtensionContext;
  importService: ImportService;
  totals: Totals;
  updateStatusBar: () => void;
  gotoSymbol: GotoSymbolFn;
  document?: DvDocument;
  allowImpactSummary: boolean;
}

/**
 * Thin lifecycle wrapper around the message router + webview postMessage,
 * used by both the panel and the custom editor.
 */
export class WebviewController implements vscode.Disposable {
  private sub?: vscode.Disposable;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly opts: WebviewControllerOptions
  ) {}

  attach(): void {
    // Wire message router
    this.sub = registerWebviewMessageHandlers(this.panel, {
      context: this.opts.context,
      importService: this.opts.importService,
      totals: this.opts.totals,
      updateStatusBar: this.opts.updateStatusBar,
      gotoSymbol: this.opts.gotoSymbol,
      document: this.opts.document,
      allowImpactSummary: this.opts.allowImpactSummary
    });
    // Clean up with panel
    this.panel.onDidDispose(() => this.sub?.dispose());
  }

  /** Always return a real Promise so callers can .catch/.finally safely */
  post(message: WebviewOutbound): Promise<boolean> {
    const t = this.panel.webview.postMessage(message);
    // Promise.resolve will assimilate Thenables into a native Promise<boolean>
    return Promise.resolve(t as unknown as Promise<boolean>);
  }

  dispose(): void {
    this.sub?.dispose();
  }
}
