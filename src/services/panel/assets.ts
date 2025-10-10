import * as vscode from 'vscode';

export interface WebviewAssets {
  scriptUris: string[];
  styleUri: string;
  codiconUri: string;
  iconDark: string;
  iconLight: string;
  dataUri: string; // required by getPanelHtml; use '' when no sample
}

export function getWebviewAssets(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  opts?: { includeSample?: boolean }
): WebviewAssets {
  const join = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...p)).toString();
  const scriptStateUri   = join('media', 'webview-state.js');
  const scriptUiUri      = join('media', 'webview-ui.js');
  const scriptUri        = join('media', 'webview.js');
  const scriptGeomUri    = join('media', 'webview-geom.js');
  const scriptInteractUri= join('media', 'webview-interact.js');
  const scriptArrangeUri = join('media', 'webview-arrange.js');
  const scriptDataUri    = join('media', 'webview-data.js');
  const styleUri         = join('media', 'webview.css');
  const codiconUri       = join('media', 'codicon.css');
  const iconDark         = join('media', 'depviz-dark.svg');
  const iconLight        = join('media', 'depviz-light.svg');
  const dataUri          = opts?.includeSample ? join('media', 'sampleData.json') : '';

  return {
    scriptUris: [
      scriptStateUri,
      scriptUiUri,
      scriptUri,
      scriptGeomUri,
      scriptInteractUri,
      scriptArrangeUri,
      scriptDataUri
    ],
    styleUri,
    codiconUri,
    iconDark,
    iconLight,
    dataUri
  };
}
