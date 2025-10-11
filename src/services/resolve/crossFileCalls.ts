// src/services/resolve/crossFileCalls.ts
import * as vscode from 'vscode';
import { GraphArtifacts, GraphNode, Edge, FuncNode } from '../../shared/types';
import { ParseService } from '../parse/parseService';

/**
 * After a file has been parsed and sent to the webview, try to add
 * cross-file call edges using VS Code's Call Hierarchy.
 *
 * We only create edges when:
 *  - We can prepare the call hierarchy at a function position in the source file
 *  - The outgoing call target resolves to a function we already parsed in another file
 *
 * Edges are posted as an additional 'addArtifacts' with only edges[].
 */
export async function resolveCrossFileCallsForFile(
  uri: vscode.Uri,
  parseService: ParseService,
  webview: vscode.Webview
): Promise<void> {
  // Get our own functions in this file
  const thisArtifacts = parseService.getIndex().get(uri.fsPath);
  if (!thisArtifacts) return;

  const fnNodes = thisArtifacts.nodes.filter(n => n.kind === 'func') as FuncNode[];
  if (!fnNodes.length) return;

  // Build quick lookups of functions by (file → simpleName → FuncNode[])
  const byFileThenName = buildWorkspaceFuncIndex(parseService);

  // Dedup edges emitted in this pass
  const emit: Edge[] = [];
  const seen = new Set<string>();
  const ek = (e: Edge) => `${e.from}->${e.to}:${e.type}`;

  for (const fn of fnNodes) {
    const pos = toPosition(fn);
    if (!pos) continue;

    let head: any;
    try {
      const prepared = await vscode.commands.executeCommand<any>('vscode.prepareCallHierarchy', uri, pos);
      head = Array.isArray(prepared) ? prepared[0] : prepared;
      if (!head) continue;
    } catch {
      // Server doesn't support Call Hierarchy: skip this function
      continue;
    }

    let outgoing: any[] = [];
    try {
      const oc = await vscode.commands.executeCommand<any>('vscode.provideCallHierarchyOutgoingCalls', head);
      outgoing = Array.isArray(oc) ? oc : [];
    } catch {
      outgoing = [];
    }

    for (const oc of outgoing) {
      const item = oc?.to;
      if (!item?.uri || !item?.name) continue;

      const targetFs = fileKey(item.uri);
      const simple = simpleName(item.name);
      const candidates = byFileThenName.get(targetFs)?.get(simple);
      if (!candidates?.length) continue;

      // Choose a target: prefer closest line to the first span in oc.fromRanges, else first candidate
      const best = pickBestTarget(item, candidates);
      if (!best) continue;

      const edge: Edge = { from: fn.id, to: best.id, type: 'call' };
      const key = ek(edge);
      if (!seen.has(key)) {
        seen.add(key);
        emit.push(edge);
      }
    }
  }

  if (emit.length) {
    await webview.postMessage({ type: 'addArtifacts', payload: { nodes: [], edges: emit } });
  }
}

function toPosition(fn: FuncNode): vscode.Position | null {
  try {
    const line = Math.max(0, fn.range?.line ?? 0);
    const col = Math.max(0, fn.range?.col ?? 0);
    return new vscode.Position(line, col);
  } catch {
    return null;
  }
}

function simpleName(name: string): string {
  const s = String(name || '');
  const last = s.split('.').pop() || s;
  // strip common “ClassName.method(…)” or “func(…)” decorations if returned by some servers
  return last.replace(/\(.*$/, '');
}

function fileKey(uri: vscode.Uri): string {
  return vscode.Uri.file(uri.fsPath).fsPath;
}

function buildWorkspaceFuncIndex(parseService: ParseService) {
  const byFile = new Map<string, Map<string, FuncNode[]>>();
  for (const [fsPath, art] of parseService.getIndex()) {
    const fnNodes = (art.nodes || []).filter(n => n.kind === 'func') as FuncNode[];
    if (!fnNodes.length) continue;
    const nameMap = new Map<string, FuncNode[]>();
    for (const fn of fnNodes) {
      const key = simpleName(fn.label || '');
      if (!nameMap.has(key)) nameMap.set(key, []);
      nameMap.get(key)!.push(fn);
    }
    byFile.set(fsPath, nameMap);
  }
  return byFile;
}

function pickBestTarget(item: any, candidates: FuncNode[]): FuncNode | null {
  if (!candidates.length) return null;
  try {
    const span = (item.selectionRange || item.range);
    const tLine = span?.start?.line ?? null;
    if (tLine == null) return candidates[0];
    let best: FuncNode = candidates[0];
    let bestDelta = Number.MAX_SAFE_INTEGER;
    for (const c of candidates) {
      const line = c.range?.line ?? 0;
      const delta = Math.abs(line - tLine);
      if (delta < bestDelta) { bestDelta = delta; best = c; }
    }
    return best;
  } catch {
    return candidates[0];
  }
}
