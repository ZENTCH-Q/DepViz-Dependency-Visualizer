// src/services/navigation/gotoSymbol.ts
import * as vscode from 'vscode';
import { escapeReg } from '../../shared/text';

export interface SymbolTarget {
  file?: string;
  name: string;
}

export type GotoSymbolFn = (target: SymbolTarget, peek: boolean, beside: boolean) => Promise<void>;

export const gotoSymbol: GotoSymbolFn = async (target, peek, beside) => {
  try {
    if (!target || !target.name) return;

    const location = await resolveSymbolLocation(target);
    if (!location) {
      vscode.window.showWarningMessage(`DepViz: couldn't find "${target.name}".`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(location.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: beside ? vscode.ViewColumn.Beside : undefined,
      preserveFocus: false
    });

    // Try to highlight exactly the identifier (fallback to selectionRange/range)
    const defLine = location.range.start.line;
    const lineText = doc.lineAt(defLine).text;
    const nameRe = new RegExp(`\\b${escapeReg(target.name)}\\b`);
    const match = nameRe.exec(lineText);

    let selRange: vscode.Range;
    if (match) {
      const start = new vscode.Position(defLine, match.index);
      const end = start.translate(0, target.name.length);
      selRange = new vscode.Range(start, end);
    } else {
      // Fallback: use the location’s selection range if available
      const r = (location as any).selectionRange ?? location.range;
      selRange = new vscode.Range(r.start, r.end);
    }

    editor.selection = new vscode.Selection(selRange.start, selRange.end);
    editor.revealRange(selRange, vscode.TextEditorRevealType.InCenter);

    if (peek) {
      try {
        await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
      } catch {
        // optional: ignore if command not available
      }
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(err?.message || String(err));
  }
};

async function resolveSymbolLocation(target: SymbolTarget): Promise<vscode.Location | null> {
  const name = target.name;
  if (target.file) {
    const uri = vscode.Uri.file(target.file);
    const inFile = await lookupInFile(uri, name);
    if (inFile) return inFile;
  }
  const inWorkspace = await lookupInWorkspace(name);
  if (inWorkspace) return inWorkspace;

  if (target.file) {
    const uri = vscode.Uri.file(target.file);
    const scan = await regexScan(uri, name);
    if (scan) return scan;
  }
  return null;
}

async function lookupInFile(uri: vscode.Uri, name: string): Promise<vscode.Location | null> {
  const res = await vscode.commands.executeCommand<any>('vscode.executeDocumentSymbolProvider', uri);
  const symbols: vscode.DocumentSymbol[] = Array.isArray(res) ? res : [];
  const flat: vscode.DocumentSymbol[] = [];
  const walk = (symbol: vscode.DocumentSymbol) => {
    flat.push(symbol);
    symbol.children?.forEach(walk);
  };
  symbols.forEach(walk);

  const last = (name || '').split('.').pop() || name;
  const candidate =
    flat.find(s => s.name === name) ||
    flat.find(s => s.name === last) ||
    flat.find(s => (s.name.split('.').pop() || s.name) === last) ||
    flat.find(s => s.name.toLowerCase() === last.toLowerCase());

  if (!candidate) return null;
  const range = candidate.selectionRange ?? candidate.range;
  return new vscode.Location(uri, range);
}

async function lookupInWorkspace(name: string): Promise<vscode.Location | null> {
  const res = await vscode.commands.executeCommand<any>('vscode.executeWorkspaceSymbolProvider', name);
  const infos: vscode.SymbolInformation[] = Array.isArray(res) ? res : [];
  const last = (name || '').split('.').pop() || name;

  const functionKinds = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor
  ]);

  const filtered = infos.filter(s => functionKinds.has(s.kind));
  const pick =
    filtered.find(s => s.name === name) ||
    filtered.find(s => s.name === last) ||
    filtered.find(s => (s.name.split('.').pop() || s.name) === last) ||
    filtered.find(s => s.name.toLowerCase() === last.toLowerCase()) ||
    null;

  return pick ? pick.location : null;
}

async function regexScan(uri: vscode.Uri, name: string): Promise<vscode.Location | null> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();

    // Prefer a function-call token first
    let match = new RegExp(String.raw`\b${escapeReg(name)}\s*\(`, 'g').exec(text);
    if (match) {
      const pos = doc.positionAt(match.index);
      return new vscode.Location(uri, new vscode.Range(pos, pos.translate(0, name.length)));
    }

    // Then try a few common definition patterns
    const definitions = [
      new RegExp(String.raw`^\s*def\s+${escapeReg(name)}\s*\(`, 'm'),
      new RegExp(String.raw`^\s*(?:export\s+)?function\s+${escapeReg(name)}\s*\(`, 'm'),
      new RegExp(String.raw`^\s*(?:public|private|protected|static\s+)*${escapeReg(name)}\s*\(`, 'm')
    ];
    for (const re of definitions) {
      match = re.exec(text);
      if (match) {
        const pos = doc.positionAt(match.index);
        return new vscode.Location(uri, new vscode.Range(pos, pos.translate(0, name.length)));
      }
    }
  } catch {
    // ignore
  }
  return null;
}
