// src/services/resolve/crossFileCalls.ts
import * as vscode from 'vscode';
import { Edge, FuncNode } from '../../shared/types';
import { ParseService } from '../parse/parseService';

// Cache Call Hierarchy results per (file#line:col)
const chCache = new Map<string, any[]>();

export async function resolveCrossFileCallsForFile(
  uri: vscode.Uri,
  parseService: ParseService,
  webview: vscode.Webview
): Promise<void> {
  const artifacts = parseService.getIndex().get(uri.fsPath);
  if (!artifacts) return;

  const fnNodes = (artifacts.nodes || []).filter(n => n.kind === 'func') as FuncNode[];
  if (!fnNodes.length) return;

  // Single path: Call Hierarchy + local workspace function index
  const byFileThenName = buildWorkspaceFuncIndex(parseService);
  const emit: Edge[] = [];
  const seen = new Set<string>();
  const ek = (e: Edge) => `${e.from}->${e.to}:${e.type}`;

  for (const fn of fnNodes) {
    const pos = toPosition(fn);
    if (!pos) continue;

    const key = `${uri.fsPath}#${pos.line}:${pos.character}`;
    let outgoing: any[] | undefined = chCache.get(key);
    if (!outgoing) {
      let head: any;
      try {
        const prepared = await vscode.commands.executeCommand<any>('vscode.prepareCallHierarchy', uri, pos);
        head = Array.isArray(prepared) ? prepared[0] : prepared;
        if (!head) continue;
      } catch { continue; }
      try {
        const oc = await vscode.commands.executeCommand<any>('vscode.provideCallHierarchyOutgoingCalls', head);
        outgoing = Array.isArray(oc) ? oc : [];
      } catch { outgoing = []; }
      chCache.set(key, outgoing);
    }

    for (const oc of outgoing) {
      const item = oc?.to;
      if (!item?.uri || !item?.name) continue;

      const targetFs = fileKey(item.uri);
      const simple = simpleName(item.name);
      const candidates = byFileThenName.get(targetFs)?.get(simple);
      if (!candidates?.length) continue;

      const best = pickBestTarget(item, candidates);
      if (!best) continue;

      const edge: Edge = { from: fn.id, to: best.id, type: 'call', provenance: 'hierarchy', confidence: 1 };
      const key2 = ek(edge);
      if (!seen.has(key2)) {
        seen.add(key2);
        emit.push(edge);
      }
    }
  }

  const cap = vscode.workspace.getConfiguration('depviz').get<number>('crossFileCallsMax') ?? 5000;
  const payload = emit.slice(0, Math.max(1, cap));
  if (emit.length > cap) {
    vscode.window.showInformationMessage(`DepViz: Cross-file calls capped at ${cap} (configure depviz.crossFileCallsMax).`);
  }
  if (payload.length) {
    await webview.postMessage({ type: 'addArtifacts', payload: { nodes: [], edges: payload } });
  }
}

export function clearCrossFileCache(): void {
  chCache.clear();
}

function toPosition(fn: FuncNode): vscode.Position | null {
  try {
    const line = Math.max(0, fn.range?.line ?? 0);
    const col = Math.max(0, fn.range?.col ?? 0);
    return new vscode.Position(line, col);
  } catch { return null; }
}

function simpleName(name: string): string {
  const s = String(name || '');
  const last = s.split('.').pop() || s;
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
    let best = candidates[0];
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
