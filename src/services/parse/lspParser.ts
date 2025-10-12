// src/services/parse/lspParser.ts
import * as vscode from 'vscode';
import { ParseResult, Edge } from '../../shared/types';
import { snippetFrom } from '../../shared/text';
import { normalizePosixPath, makeModuleId, makeClassId, makeFuncId } from './utils';

// Extend with optional containerName for SymbolInformation normalization.
type DS = vscode.DocumentSymbol & { children: vscode.DocumentSymbol[]; containerName?: string; };

function asDocumentSymbols(result: any): DS[] {
  if (!Array.isArray(result) || result.length === 0) return [];
  const looksLikeSymbolInfo = typeof (result[0] as any)?.location !== 'undefined';
  if (!looksLikeSymbolInfo) {
    return (result as vscode.DocumentSymbol[]).map(s => ({ ...s, children: s.children ?? [] })) as DS[];
  }
  const infos = result as vscode.SymbolInformation[];
  return infos.map(i => {
    const range = i.location?.range ?? new vscode.Range(0, 0, 0, 0);
    const selectionRange = range;
    return { name: i.name, detail: '', kind: i.kind, range, selectionRange, children: [], containerName: i.containerName } as DS;
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

  // --- IMPORTANT: open the document FIRST to warm up language features ---
  const document = await vscode.workspace.openTextDocument(uri);

  // Ask for symbols, but retry briefly if LS is cold (esp. Python)
  const symbols = await getSymbolsWithWarmup(document);

  if (!symbols.length) {
    diagnostics.push({ file: uri.fsPath, severity: 'warn', message: 'Language Server returned no symbols for this file.' });
  }

  const functions: Fn[] = [];
  const classIds = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  const addFunction = (name: string, selection: vscode.Range, full: vscode.Range, parent: string) => {
    const id = makeFuncId(fileLabel, name, selection.start.line);
    functions.push({ id, name, start: selection.start.line, end: full.end.line, col: selection.start.character, parent });
  };

  const visit = (symbol: DS, parentClassName?: string) => {
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
      for (const c of symbol.children) visit(c, className);
      return;
    }

    if (symbol.kind === vscode.SymbolKind.Function || symbol.kind === vscode.SymbolKind.Method) {
      const clsName = parentClassName ?? symbol.containerName;
      const parentId = clsName ? (classIds.get(clsName) ?? moduleId) : moduleId;
      const fname = clsName ? `${clsName}.${symbol.name}` : symbol.name;
      addFunction(fname, symbol.selectionRange ?? symbol.range, symbol.range, parentId);
    }

    for (const c of symbol.children) visit(c, parentClassName);
  };
  for (const s of symbols) visit(s);

  // ---- Python heuristic fallback when LSP gives us nothing usable ----
  if (!functions.length && uri.fsPath.toLowerCase().endsWith('.py')) {
    const { classNodes, fnList } = harvestPythonHeuristics(text, fileLabel, uri, moduleId);
    for (const n of classNodes) nodes.push(n);
    for (const f of fnList) functions.push(f);
    diagnostics.push({ file: uri.fsPath, severity: 'warn', message: 'LSP returned no functions; filled via Python heuristics.' });
  }

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

  // Same-file calls ONLY via Call Hierarchy; no heuristic regex
  await addSameFileCallEdges(uri, functions, edges);

  const status: ParseResult['status'] = symbols.length ? 'ok' : (functions.length ? 'partial' : 'partial');
  const modNode = nodes.find(n => n.id === moduleId);
  if (modNode) {
    (modNode as any).lspStatus = status;
    (modNode as any).heuristicCalls = false;
  }
  return { nodes, edges, status, diagnostics };
}

// Try symbols a few times to let LS warm up (especially Python on first touch)
async function getSymbolsWithWarmup(document: vscode.TextDocument): Promise<DS[]> {
  const uri = document.uri;

  let result = await vscode.commands.executeCommand<any>('vscode.executeDocumentSymbolProvider', uri);
  let symbols = asDocumentSymbols(result);
  if (symbols.length) return symbols;

  const isPython = (document.languageId || '').toLowerCase() === 'python';
  const retries = isPython ? 3 : 2;
  const base = 150; // ms

  for (let i = 0; i < retries && symbols.length === 0; i++) {
    await sleep(base * Math.pow(2, i)); // 150, 300, 600
    try {
      // nudge LS; ignore if not supported
      await vscode.commands.executeCommand('vscode.prepareCallHierarchy', uri, new vscode.Position(0, 0));
    } catch {
      /* ignore */
    }
    result = await vscode.commands.executeCommand<any>('vscode.executeDocumentSymbolProvider', uri);
    symbols = asDocumentSymbols(result);
  }
  return symbols;
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, Math.max(0, ms|0))); }

// --- Heuristic helpers for Python when doc symbols are empty ---
function harvestPythonHeuristics(text: string, fileLabel: string, uri: vscode.Uri, moduleId: string) {
  const classNodes: any[] = [];
  const fnList: Fn[] = [];

  const classRe = /^\s*class\s+([A-Za-z_]\w*)\s*[:\(]/gm;
  const funcRe  = /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm;

  // Classes
  for (const m of text.matchAll(classRe)) {
    if (!m.index && m.index !== 0) continue;
    const clsName = m[1];
    const line = text.slice(0, m.index!).split(/\r?\n/).length - 1;
    const classId = makeClassId(fileLabel, clsName);
    classNodes.push({
      id: classId,
      kind: 'class',
      label: clsName,
      parent: moduleId,
      docked: true,
      fsPath: uri.fsPath,
      range: { line, col: 0 }
    });
  }

  // Functions (module-level only)
  for (const m of text.matchAll(funcRe)) {
    if (!m.index && m.index !== 0) continue;
    const fnName = m[1];
    const line = text.slice(0, m.index!).split(/\r?\n/).length - 1;
    const id = makeFuncId(fileLabel, fnName, line);
    fnList.push({ id, name: fnName, start: line, end: line, col: 0, parent: moduleId });
  }

  return { classNodes, fnList };
}

async function addSameFileCallEdges(uri: vscode.Uri, functions: Fn[], edges: Edge[]) {
  for (const fn of functions) {
    try {
      const pos = new vscode.Position(fn.start, Math.max(0, fn.col));
      let prepared: any;
      try {
        const r = await vscode.commands.executeCommand<any>('vscode.prepareCallHierarchy', uri, pos);
        prepared = Array.isArray(r) ? r[0] : r;
      } catch {
        prepared = undefined;
      }
      if (!prepared) continue;

      let outgoing: any;
      try {
        const oc = await vscode.commands.executeCommand<any>('vscode.provideCallHierarchyOutgoingCalls', prepared);
        outgoing = Array.isArray(oc) ? oc : [];
      } catch {
        outgoing = [];
      }

      for (const oc of outgoing) {
        const calleeName: string = oc?.to?.name || '';
        if (!calleeName) continue;
        const tSel = (oc?.to?.selectionRange || oc?.to?.range);
        const tLine = tSel?.start?.line ?? null;
        let target = null;
        if (tLine != null) target = functions.find(f => f.start === tLine);
        if (!target) {
          const simple = (calleeName.split('.').pop() || '').replace(/\(.*$/, '');
          target = functions.find(f => (f.name.split('.').pop() || '') === simple);
        }
        if (target) {
          edges.push({ from: fn.id, to: target.id, type: 'call', heuristic: false, provenance: 'hierarchy', confidence: 1 });
        }
      }
    } catch {
      // Some servers don’t implement Call Hierarchy; skip silently.
    }
  }
}
