// src/core/symbolIndex.ts
import { GraphNode } from './types';
import { bareFromLabel } from '../core/labels';
import { toPosix } from '../core/paths';

export type FuncEntry = {
  id: string;       // node id (fn_...)
  bare: string;     // bare name (no class / no parens)
  file: string;     // normalized fsPath
  moduleId: string; // owning module id
};

const funcsByBare = new Map<string, FuncEntry[]>();
const funcsById   = new Map<string, FuncEntry>();
// Track membership so we can cleanly evict on re-import.
const funcIdsByModule = new Map<string, Set<string>>();

export function clearIndex() {
  funcsByBare.clear();
  funcsById.clear();
  funcIdsByModule.clear();
}

function addEntry(ent: FuncEntry) {
  funcsById.set(ent.id, ent);
  if (!funcIdsByModule.has(ent.moduleId)) funcIdsByModule.set(ent.moduleId, new Set());
  funcIdsByModule.get(ent.moduleId)!.add(ent.id);

  const arr = funcsByBare.get(ent.bare) || [];
  arr.push(ent);
  funcsByBare.set(ent.bare, arr);
}

function removeEntry(id: string) {
  const ent = funcsById.get(id);
  if (!ent) return;
  funcsById.delete(id);
  const modSet = funcIdsByModule.get(ent.moduleId);
  if (modSet) { modSet.delete(id); if (!modSet.size) funcIdsByModule.delete(ent.moduleId); }

  const arr = funcsByBare.get(ent.bare);
  if (!arr) return;
  const next = arr.filter(e => e.id !== id);
  if (next.length) funcsByBare.set(ent.bare, next); else funcsByBare.delete(ent.bare);
}

export function indexModuleNodes(nodes: GraphNode[]) {
  const mod = nodes.find(n => n.kind === 'module');
  if (!mod) return;
  const moduleId = mod.id;
  const file = toPosix(mod.fsPath || '');

  // If we've indexed this module before, evict its old funcs first.
  const prev = funcIdsByModule.get(moduleId);
  if (prev) for (const id of prev) removeEntry(id);

  for (const n of nodes) {
    if (n.kind !== 'func') continue;
    const bare = bareFromLabel(n.label);
    addEntry({ id: n.id, bare, file, moduleId });
  }
}

export function removeModuleNodes(nodes: GraphNode[]) {
  const mod = nodes.find(n => n.kind === 'module');
  if (!mod) return;
  const set = funcIdsByModule.get(mod.id);
  if (!set) return;
  for (const id of set) removeEntry(id);
  funcIdsByModule.delete(mod.id);
}

export function uniqueGlobalMatch(bare: string, excludeModuleId?: string): FuncEntry | null {
  const arr = funcsByBare.get(bare);
  if (!arr || arr.length === 0) return null;
  const filtered = excludeModuleId ? arr.filter(a => a.moduleId !== excludeModuleId) : arr;
  return filtered.length === 1 ? filtered[0] : null;
}

export function findFuncInFile(bare: string, filePosix: string): FuncEntry | null {
  const arr = funcsByBare.get(bare);
  if (!arr || !arr.length) return null;
  const f = arr.find(e => e.file === toPosix(filePosix));
  return f || null;
}
