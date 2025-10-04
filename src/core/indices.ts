// src/core/indices.ts
import { GraphNode, GraphEdge } from './types';
import { bareFromLabel } from '../core/labels';

export function makeEdgeKey(e: Pick<GraphEdge,'from'|'to'|'type'>): string {
  return `${e.from}->${e.to}:${e.type}`;
}

export function indexNodes(nodes: GraphNode[]) {
  const byId = new Map<string, GraphNode>();
  const childrenByParent = new Map<string, GraphNode[]>();
  const funcsByName = new Map<string, string[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.parent) {
      if (!childrenByParent.has(n.parent)) childrenByParent.set(n.parent, []);
      childrenByParent.get(n.parent)!.push(n);
    }
    if (n.kind === 'func') {
      const name = bareFromLabel(n.label);
      if (!funcsByName.has(name)) funcsByName.set(name, []);
      funcsByName.get(name)!.push(n.id);
    }
  }
  return { byId, childrenByParent, funcsByName };
}
