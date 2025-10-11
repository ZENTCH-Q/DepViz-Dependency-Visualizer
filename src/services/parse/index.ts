// src/services/parse/index.ts
import * as vscode from 'vscode';
import { ParseResult, GraphArtifacts, Diagnostic, GraphNode, Edge, ModuleNode } from '../../shared/types';
import { makeModuleId } from './utils';
import { parseWithLsp } from './lspParser';

/**
 * Top-level parser with tiered fallback:
 *  - Try LSP (symbols + optional call hierarchy)
 *  - On failure: still emit a module node + static import sniffing (no funcs/classes)
 */
export async function parseFile(uri: vscode.Uri, text?: string, timeoutMs = 3000): Promise<ParseResult> {
  const src = text ?? (await vscode.workspace.openTextDocument(uri)).getText();
  // Race LSP parse with a timeout
  try {
    const lspP = parseWithLsp(uri, src);
    const res = await timeout(lspP, timeoutMs);
    // Always ensure we have at least a module node (should already be present)
    if (!res.nodes.some(n => n.kind === 'module')) {
      res.nodes.unshift(moduleOnlyNode(uri, src));
    }
    // ensure module carries status if not already set
    for (const n of res.nodes) {
      if (n.kind === 'module' && !(n as any).lspStatus) {
        (n as any).lspStatus = res.status;
      }
    }
    return res;
  } catch (err: any) {
    // Hard fallback: module-only + import edges
    const diag: Diagnostic = {
      file: uri.fsPath,
      severity: 'warn',
      message: `LSP unavailable or slow: ${err?.message ?? 'timeout'}`
    };
    const mod: ModuleNode = moduleOnlyNode(uri, src);
    const edges = staticImportEdges(mod.id, src);
    const modWithStatus: ModuleNode = { ...mod, lspStatus: 'nolsp' };
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

// Extremely light import sniffing for JS/TS/Python; ignores unresolved targets.
function staticImportEdges(moduleId: string, text: string): Edge[] {
  const targets = new Set<string>();
  // Python
  text.replace(/^\s*from\s+([\w\.]+)\s+import\b/igm, (_m, a) => { targets.add(String(a)); return ''; });
  text.replace(/^\s*import\s+([\w\.]+)/igm, (_m, a) => { targets.add(String(a)); return ''; });
  // JS/TS (ESM/CommonJS)
  text.replace(/^\s*import\s+[^'"]*?['"]([^'"]+)['"]/igm, (_m, a) => { targets.add(String(a)); return ''; });
  text.replace(/require\(\s*['"]([^'"]+)['"]\s*\)/g, (_m, a) => { targets.add(String(a)); return ''; });

  const edges: Edge[] = [];
  for (const t of targets) {
    const toId = makeModuleId(normalizeTarget(t));
    edges.push({ from: moduleId, to: toId, type: 'import' });
  }
  return edges;
}

// ---- Helpers also used elsewhere ----
export function normalizeTarget(s: string): string {
  return s.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\\/g, '/');
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
