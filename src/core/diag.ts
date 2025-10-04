// src/core/diag.ts
import * as vscode from 'vscode';

let ch: vscode.OutputChannel | null = null;
let onceFlags = new Set<string>();
let status: vscode.StatusBarItem | null = null;

export function initDiag(context: vscode.ExtensionContext) {
  if (!ch) ch = vscode.window.createOutputChannel('DepViz');
  if (!status) {
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    status.text = 'DepViz: $(pulse) diag';
    status.tooltip = 'Open DepViz diagnostics';
    status.command = 'depviz.diagnostics';
    status.hide(); // only show when there’s something notable
    context.subscriptions.push(status);
  }
}

export function showStatus() { status?.show(); }
export function hideStatus() { status?.hide(); }

export function info(msg: string) { ch?.appendLine(`[info] ${msg}`); }
export function warn(msg: string) { ch?.appendLine(`[warn] ${msg}`); showStatus(); }
export function error(msg: string) { ch?.appendLine(`[error] ${msg}`); showStatus(); }

export function onceWarn(key: string, msg: string) {
  if (onceFlags.has(key)) return;
  onceFlags.add(key);
  warn(msg);
  vscode.window.showWarningMessage(msg, 'Open diagnostics').then(p => {
    if (p) ch?.show(true);
  });
}

export function open() { ch?.show(true); }

// Convenience for adapters
export function noteWasm(lang: string, ok: boolean, file: string, err?: unknown) {
  if (ok) info(`${lang}: loaded WASM → ${file}`);
  else {
    const why = (err instanceof Error ? err.message : String(err ?? 'unknown'));
    onceWarn(`wasm:${lang}`, `${lang}: WASM not loaded (${file}). Falling back to regex. Reason: ${why}`);
  }
}
