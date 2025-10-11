// src/shared/types.ts
export type GraphNodeKind = 'module' | 'class' | 'func';

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  parent?: string;
  fsPath?: string;
  source?: string;
  docked?: boolean;
  snippet?: string;
  range?: { line: number; col: number };
};

export type GraphEdge = {
  from: string;
  to: string;
  type: 'call' | 'import';
};

export type GraphArtifacts = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

// Added for status bar totals
export interface Totals {
  modules: number;
  funcs: number;
}
