// src/services/parse/lspParser.ts
import * as vscode from 'vscode';
import { ParseResult, Edge } from '../../shared/types';
import { snippetFrom } from '../../shared/text';
import {
  stripStringsAndComments,
  normalizeContinuations,
  resolveImportLabelByText
} from '../../shared/parseUtils';
import {
  normalizePosixPath,
  makeModuleId,
  makeClassId,
  makeFuncId
} from './utils';

// Extend with optional containerName so flat SymbolInformation can still convey parents.
type DS = vscode.DocumentSymbol & {
  children: vscode.DocumentSymbol[];
  containerName?: string;
};

function asDocumentSymbols(result: any): DS[] {
  if (!Array.isArray(result) || result.length === 0) return [];
  // If the first element has "location", it's SymbolInformation[]
  const looksLikeSymbolInfo = typeof (result[0] as any)?.location !== 'undefined';

  if (!looksLikeSymbolInfo) {
    // Trust it is DocumentSymbol[]
    return (result as vscode.DocumentSymbol[]).map(s => ({
      ...s,
      children: s.children ?? []
    })) as DS[];
  }

  // Normalize SymbolInformation[] → flat DocumentSymbol-like array (no hierarchy)
  const infos = result as vscode.SymbolInformation[];
  return infos.map((i) => {
    const range = i.location?.range ?? new vscode.Range(0, 0, 0, 0);
    const selectionRange = range; // best effort
    const ds: DS = {
      name: i.name,
      detail: '',
      kind: i.kind,
      range,
      selectionRange,
      children: [],
      containerName: i.containerName
    } as DS;
    return ds;
  });
}

type Fn = { id: string; name: string; start: number; end: number; col: number; parent: string };

export async function parseWithLsp(uri: vscode.Uri, text: string): Promise<ParseResult> {
  const fileLabel = vscode.workspace.asRelativePath(uri, false);
  const moduleLabelKey = normalizePosixPath(fileLabel);
  const moduleId = makeModuleId(moduleLabelKey);

  const nodes: any[] = [{
    id: moduleId,
    kind: 'module',
    label: fileLabel,
    fsPath: uri.fsPath,
    source: text,
    collapsed: true
  }];
  const edges: Edge[] = [];
  const diagnostics: ParseResult['diagnostics'] = [];

  // Ask the language server for symbols
  const raw = await vscode.commands.executeCommand<any>('vscode.executeDocumentSymbolProvider', uri);
  const symbols = asDocumentSymbols(raw);

  if (!symbols.length) {
    diagnostics.push({
      file: uri.fsPath,
      severity: 'warn',
      message: 'Language Server returned no symbols for this file.'
    });
  }

  // Collect functions/methods (+ classes for docking)
  const functions: Fn[] = [];
  const classIds = new Map<string, string>();

  const document = await vscode.workspace.openTextDocument(uri);
  const lines = text.split(/\r?\n/);

  const addFunction = (name: string, selection: vscode.Range, full: vscode.Range, parent: string) => {
    const id = makeFuncId(fileLabel, name, selection.start.line);
    functions.push({
      id,
      name,
      start: selection.start.line,
      end: full.end.line,
      col: selection.start.character,
      parent
    });
  };

  // If we have a hierarchy (DocumentSymbol), we’ll walk it.
  // If the server returned flat symbols (SymbolInformation normalized), children=[]
  // so this naturally degrades to a flat pass.
  const visit = (symbol: DS, parentClassName?: string) => {
    // Class
    if (symbol.kind === vscode.SymbolKind.Class) {
      const className = symbol.name;
      if (!classIds.has(className)) {
        const classId = makeClassId(fileLabel, className);
        classIds.set(className, classId);
        nodes.push({
          id: classId,
          kind: 'class',
          label: className,
          parent: moduleId,
          docked: true,
          snippet: document.getText(symbol.range).split(/\r?\n/).slice(0, 20).join('\n'),
          fsPath: uri.fsPath,
          range: { line: symbol.selectionRange.start.line, col: symbol.selectionRange.start.character }
        });
      }
      // Children may be empty for flat servers; we still call visit for completeness.
      for (const c of symbol.children) visit(c, className);
      return;
    }

    // Function or Method
    if (symbol.kind === vscode.SymbolKind.Function || symbol.kind === vscode.SymbolKind.Method) {
      // Prefer explicit parent from traversal; otherwise try SymbolInformation.containerName
      const clsName = parentClassName ?? symbol.containerName;
      const parentId = clsName ? (classIds.get(clsName) ?? moduleId) : moduleId;
      const fname = clsName ? `${clsName}.${symbol.name}` : symbol.name;
      addFunction(fname, symbol.selectionRange ?? symbol.range, symbol.range, parentId);
    }

    for (const c of symbol.children) visit(c, parentClassName);
  };

  for (const s of symbols) visit(s);

  // Emit function nodes
  for (const fn of functions) {
    nodes.push({
      id: fn.id,
      kind: 'func',
      label: fn.name,
      parent: fn.parent,
      docked: true,
      snippet: snippetFrom(lines, fn.start),
      fsPath: uri.fsPath,
      range: { line: fn.start, col: fn.col }
    });
  }

  // --- Calls: prefer Call Hierarchy (precise), then fallback heuristic ---
  let usedCallHierarchy = false;
  try {
    usedCallHierarchy = await tryCallHierarchy(uri, functions, edges);
  } catch {
    usedCallHierarchy = false;
  }

  if (!usedCallHierarchy) {
    // Heuristic body token scan (as before), but mark edges as heuristic
    const bare = (name: string) => (name.includes('.') ? name.split('.').pop() || name : name);
    const nameToIds = new Map<string, string[]>();
    for (const fn of functions) {
      const key = bare(fn.name);
      if (!nameToIds.has(key)) nameToIds.set(key, []);
      nameToIds.get(key)!.push(fn.id);
    }

    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexCache = new Map<string, RegExp>();
    const wcr = (token: string) => new RegExp(String.raw`\b${escapeRegExp(token)}\s*\(`);
    const bodyOf = (fn: Fn) => {
      try {
        return document.getText(new vscode.Range(new vscode.Position(fn.start, 0), new vscode.Position(fn.end + 1, 0)));
      } catch {
        return lines.slice(fn.start, fn.end + 1).join('\n');
      }
    };

    for (const fn of functions) {
      const body = stripStringsAndComments(bodyOf(fn));
      for (const [calleeToken, ids] of nameToIds) {
        if (ids.includes(fn.id)) continue;
        const bareToken = bare(calleeToken);
        let regex = regexCache.get(bareToken);
        if (!regex) {
          regex = wcr(bareToken);
          regexCache.set(bareToken, regex);
        }
        if (regex.test(body) || (calleeToken !== bareToken && wcr(calleeToken).test(body))) {
          edges.push({ from: fn.id, to: ids[0], type: 'call', heuristic: true });
        }
      }
    }
  }

  // --- Import edges (Python + TS/JS) ---
  const importsSource = normalizeContinuations(stripStringsAndComments(text));
  const impPy = /(?:^|\n)\s*(?:from\s+([\w\.]+)\s+import\s+([A-Za-z0-9_\,\s\*\.]+)|import\s+([\w\.]+)(?:\s+as\s+\w+)?)/g;
  const impTs = /(?:^|\n)\s*(?:import\s+(?:[^'"]+)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|export\s+[^;]+?\s+from\s+['"]([^'"]+)['"])/g;

  let match: RegExpExecArray | null;
  while ((match = impPy.exec(importsSource)) !== null) {
    const target = (match[1] ?? match[3] ?? '').trim();
    if (!target) continue;
    const label = resolveImportLabelByText(fileLabel, target);
    const to = makeModuleId(label ?? target);
    edges.push({ from: moduleId, to, type: 'import' });
  }
  while ((match = impTs.exec(importsSource)) !== null) {
    const target = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!target) continue;
    const label = resolveImportLabelByText(fileLabel, target);
    const to = makeModuleId(label ?? target);
    edges.push({ from: moduleId, to, type: 'import' });
  }

  const status: ParseResult['status'] = symbols.length ? 'ok' : 'partial';
  // annotate module node with parser truth + whether calls were heuristic
  const modNode = nodes.find(n => n.id === moduleId);
  if (modNode) {
    (modNode as any).lspStatus = status;                 // 'ok' | 'partial'
    (modNode as any).heuristicCalls = !usedCallHierarchy; // boolean
  }
  return { nodes, edges, status, diagnostics };
}

// Try VS Code Call Hierarchy for precise call edges (same-file linking).
async function tryCallHierarchy(
  uri: vscode.Uri,
  functions: Fn[],
  edges: Edge[]
): Promise<boolean> {
  let any = false;
  for (const fn of functions) {
    try {
      const pos = new vscode.Position(fn.start, Math.max(0, fn.col));
      const prepared = await vscode.commands.executeCommand<any>('vscode.prepareCallHierarchy', uri, pos);
      const head = Array.isArray(prepared) ? prepared[0] : prepared;
      if (!head) continue;

      const outgoing = await vscode.commands.executeCommand<any>('vscode.provideCallHierarchyOutgoingCalls', head);
      if (!Array.isArray(outgoing)) continue;

      for (const oc of outgoing) {
        const calleeName: string = oc?.to?.name || '';
        if (!calleeName) continue;
        // naive: match against known functions within this file (by simple name)
        const simple = calleeName.split('.').pop()!;
        const target = functions.find(f => f.name.split('.').pop() === simple);
        if (target) {
          edges.push({ from: fn.id, to: target.id, type: 'call', heuristic: false });
          any = true;
        }
      }
    } catch {
      // Some servers don’t implement Call Hierarchy; skip silently.
    }
  }
  return any;
}
