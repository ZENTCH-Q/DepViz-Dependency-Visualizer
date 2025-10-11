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

  const raw = await vscode.commands.executeCommand<any>('vscode.executeDocumentSymbolProvider', uri);
  const symbols = asDocumentSymbols(raw);

  if (!symbols.length) {
    diagnostics.push({ file: uri.fsPath, severity: 'warn', message: 'Language Server returned no symbols for this file.' });
  }

  const functions: Fn[] = [];
  const classIds = new Map<string, string>();
  const document = await vscode.workspace.openTextDocument(uri);
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

  const status: ParseResult['status'] = symbols.length ? 'ok' : 'partial';
  const modNode = nodes.find(n => n.id === moduleId);
  if (modNode) {
    (modNode as any).lspStatus = status;
    (modNode as any).heuristicCalls = false;
  }
  return { nodes, edges, status, diagnostics };
}

async function addSameFileCallEdges(uri: vscode.Uri, functions: Fn[], edges: Edge[]) {
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
        const tSel = (oc?.to?.selectionRange || oc?.to?.range);
        const tLine = tSel?.start?.line ?? null;
        let target = null;
        if (tLine != null) target = functions.find(f => f.start === tLine);
        if (!target) {
          const simple = calleeName.split('.').pop()!;
          target = functions.find(f => f.name.split('.').pop() === simple);
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
