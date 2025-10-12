// src/services/parse/index.ts
import * as vscode from 'vscode';
import { ParseResult, GraphArtifacts, Diagnostic, Edge, ModuleNode } from '../../shared/types';
import { makeModuleId } from './utils';
import { stripStringsAndComments, resolveImportLabelByText } from '../../shared/parseUtils';

export async function parseFile(uri: vscode.Uri, text?: string, timeoutMs = 10000): Promise<ParseResult> {
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
    const { edges: importEdges, ghosts } = staticImportArtifacts(modId, src, uri.fsPath);

    // annotate module node status if missing
    for (const n of res.nodes) {
      if (n.kind === 'module' && !(n as any).lspStatus) {
        (n as any).lspStatus = res.status;
      }
    }

    return { ...res, nodes: [...res.nodes, ...ghosts], edges: [...(res.edges || []), ...importEdges] };
  } catch (err: any) {
    // Fallback: module + imports only
    const diag: Diagnostic = {
      file: uri.fsPath,
      severity: 'warn',
      message: `LSP unavailable or slow: ${err?.message ?? 'timeout'}`
    };
    const mod: ModuleNode = moduleOnlyNode(uri, src);
    const { edges: importEdges, ghosts } = staticImportArtifacts(mod.id, src, uri.fsPath);
    const modWithStatus: ModuleNode = { ...mod, lspStatus: 'nolsp', heuristicCalls: false };
    const partial: GraphArtifacts = { nodes: [modWithStatus, ...ghosts], edges: importEdges };
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

/**
 * Build import edges + ghost module nodes so edges can render even when target not present.
 * - Strips strings/comments to avoid false positives (e.g. '\n' becoming '/n').
 * - Python: only Python import regexes.
 * - JS/TS: standard ESM + CommonJS.
 * - Mode:
 *    'relative' (default): only relative imports
 *    'all'               : include bare imports too (e.g. "import numpy")
 *    'off'               : disabled
 */
function staticImportArtifacts(moduleId: string, text: string, fromFsPath?: string): { edges: Edge[]; ghosts: ModuleNode[] } {
  const cfg = vscode.workspace.getConfiguration('depviz');
  const mode = (cfg.get<string>('importsMode') || 'relative') as 'relative' | 'all' | 'off';
  if (mode === 'off') return { edges: [], ghosts: [] };

  const cleaned = stripStringsAndComments(text);
  const isPy = (fromFsPath || '').toLowerCase().endsWith('.py');
  const targets = new Set<string>();

  if (isPy) {
    cleaned.replace(/^\s*from\s+([A-Za-z_][\w\.]*)\s+import\b/igm, (_m, a) => { targets.add(String(a)); return ''; });
    cleaned.replace(/^\s*import\s+([A-Za-z_][\w\.]*)/igm,               (_m, a) => { targets.add(String(a)); return ''; });
  } else {
    cleaned.replace(/^\s*import\s+[^'"]*?['"]([^'"]+)['"]/igm,          (_m, a) => { targets.add(String(a)); return ''; });
    cleaned.replace(/require\(\s*['"]([^'"]+)['"]\s*\)/g,               (_m, a) => { targets.add(String(a)); return ''; });
    if (mode === 'all') {
      // A few extras when user opts in
      cleaned.replace(/^\s*(?:import|using)\s+([A-Za-z0-9_.]+)/igm,      (_m, a) => { targets.add(String(a)); return ''; }); // Java/C#
      cleaned.replace(/^\s*use\s+([A-Za-z0-9_:]+)/igm,                   (_m, a) => { targets.add(String(a).replace(/::/g, '/')); return ''; }); // Rust
    }
  }

  const edges: Edge[] = [];
  const ghosts: ModuleNode[] = [];
  const REL = /^(\.?\.?[/\\])/;

  for (const raw of targets) {
    // Normalize to a canvas label
    const label0 = resolveImportLabelByText(fromFsPath || '', String(raw)) || String(raw);
    const label = label0.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

    if (mode === 'relative' && !REL.test(label0)) continue;

    const toId = makeModuleId(label);
    edges.push({ from: moduleId, to: toId, type: 'import', provenance: 'lsp', confidence: 1 });

    // Add ghost module so the edge can render
    if (!ghosts.some(n => n.id === toId)) {
      ghosts.push({
        id: toId,
        kind: 'module',
        label,
        collapsed: true,
        heuristicCalls: false
      } as ModuleNode);
    }
  }
  return { edges, ghosts };
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
