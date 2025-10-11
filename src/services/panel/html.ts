// src/services/panel/html.ts
import * as vscode from 'vscode';

interface HtmlDeps {
  scriptUris: string[];
  styleUri: string;
  dataUri: string;
  codiconUri: string;
  iconDark: string;
  iconLight: string;
}

export function getPanelHtml(panel: vscode.WebviewPanel, deps: HtmlDeps): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${panel.webview.cspSource} blob:`,
    `style-src ${panel.webview.cspSource}`,
    `font-src ${panel.webview.cspSource}`,
    `script-src 'nonce-${nonce}' ${panel.webview.cspSource}`,
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
    </div>
    <div id="canvasWrapper">
      <svg id="canvas" tabindex="0" aria-label="dependency canvas" role="application"></svg>
    </div>
    <div id="legend"></div>

    <script nonce="${nonce}">
      window.DEPVIZ = { DATA_URI: "${deps.dataUri}" };
      window.vscode = acquireVsCodeApi();
      window.DATA_URI = window.DEPVIZ.DATA_URI;
    </script>

    ${deps.scriptUris.map(uri => `<script nonce="${nonce}" src="${uri}"></script>`).join('\n    ')}
  </body>
  </html>`;
}

export function getCustomEditorHtml(panel: vscode.WebviewPanel, deps: Omit<HtmlDeps, 'dataUri'>): string {
  const html = getPanelHtml(panel, { ...deps, dataUri: '' });
  return html;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

