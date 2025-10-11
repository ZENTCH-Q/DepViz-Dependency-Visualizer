// src/services/parse/index.ts
import * as vscode from 'vscode';
import { ParseResult, GraphArtifacts, Diagnostic, Edge, ModuleNode } from '../../shared/types';
import { makeModuleId } from './utils';

export async function parseFile(uri: vscode.Uri, text?: string, timeoutMs = 3000): Promise<ParseResult> {
  const src = text ?? (await vscode.workspace.openTextDocument(uri)).getText();

  try {
    // LSP-first with a hard timeout
    const { parseWithLsp } = await import('./lspParser');
    const lspP = parseWithLsp(uri, src);
    const res = await timeout(lspP, timeoutMs);

    // Ensure module node exists
    if (!res.nodes.some(n => n.kind === 'module')) {
      res.nodes.unshift(moduleOnlyNode(uri, src));
    }

    // Always add lightweight import edges here (single source of truth)
    const modId = res.nodes.find(n => n.kind === 'module')!.id;
    const imports = staticImportEdges(modId, src);

    // annotate module node status if missing
    for (const n of res.nodes) {
      if (n.kind === 'module' && !(n as any).lspStatus) {
        (n as any).lspStatus = res.status;
      }
    }

    return { ...res, edges: [...(res.edges || []), ...imports] };
  } catch (err: any) {
    // Fallback: module + imports only
    const diag: Diagnostic = {
      file: uri.fsPath,
      severity: 'warn',
      message: `LSP unavailable or slow: ${err?.message ?? 'timeout'}`
    };
    const mod: ModuleNode = moduleOnlyNode(uri, src);
    const edges = staticImportEdges(mod.id, src);
    const modWithStatus: ModuleNode = { ...mod, lspStatus: 'nolsp', heuristicCalls: false };
    const partial: GraphArtifacts = { nodes: [modWithStatus], edges };
    return { ...partial, status: 'nolsp', diagnostics: [diag] };
  }
}

function moduleOnlyNode(uri: vscode.Uri, src: string): ModuleNode {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return {
    id: makeModuleId(rel),
    kind: 'module',
    label: rel,
    fsPath: uri.fsPath,
    source: src,
    collapsed: true
  };
}

// Single lightweight import sniffing (JS/TS/Python; others via 'all' opt if you insist)
function staticImportEdges(moduleId: string, text: string): Edge[] {
  const mode = (vscode.workspace.getConfiguration('depviz').get<string>('importsMode') || 'relative') as 'relative'|'all'|'off';
  if (mode === 'off') return [];
  const targets = new Set<string>();
  // Python
  text.replace(/^\s*from\s+([\w\.]+)\s+import\b/igm, (_m, a) => { targets.add(String(a)); return ''; });
  text.replace(/^\s*import\s+([\w\.]+)/igm, (_m, a) => { targets.add(String(a)); return ''; });
  // JS/TS (ESM/CommonJS)
  text.replace(/^\s*import\s+[^'"]*?['"]([^'"]+)['"]/igm, (_m, a) => { targets.add(String(a)); return ''; });
  text.replace(/require\(\s*['"]([^'"]+)['"]\s*\)/g, (_m, a) => { targets.add(String(a)); return ''; });
  if (mode === 'all') {
    // Go
    text.replace(/^\s*import\s+(?:\([^\)]*\)|"([^"]+)")/igm, (_m, a) => { if (a) targets.add(String(a)); return ''; });
    text.replace(/^\s*import\s*\(\s*([\s\S]*?)\)/igm, (_m, block: string) => {
      const matches = (block.match(/"([^"]+)"/g) || []) as string[];
      matches.forEach((s: string) => targets.add(s.replace(/"/g, ''))); return '';
    });
    // Java/C#
    text.replace(/^\s*(?:import|using)\s+([A-Za-z0-9_.]+)/igm, (_m, a) => { targets.add(String(a)); return ''; });
    // Rust
    text.replace(/^\s*use\s+([A-Za-z0-9_:]+)/igm, (_m, a) => { targets.add(String(a).replace(/::/g, '/')); return ''; });
  }
  const edges: Edge[] = [];
  const REL = /^(\.?\.?[/\\])/;
  const { makeModuleId, normalizePosixPath } = require('./utils') as typeof import('./utils');
  const normalizeTarget = (s: string) => s.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\\/g, '/');
  for (const t of targets) {
    if (mode === 'relative' && !REL.test(t)) continue;
    const toId = makeModuleId(normalizeTarget(String(t)));
    edges.push({ from: moduleId, to: toId, type: 'import', provenance: 'lsp', confidence: 1 });
  }
  return edges;
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
