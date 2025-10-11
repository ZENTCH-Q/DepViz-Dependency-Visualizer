// src/shared/types.ts

export type EdgeType = 'import' | 'call';

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
  heuristic?: boolean;   // true when linked by heuristics (not proven by LSP)
  /** Source of truth for this edge; UI can display confidence. */
  provenance?: 'hierarchy' | 'refs' | 'ast' | 'lsp' | 'heuristic';
  /** 0–1 confidence; defaults to 1 when provenance is 'hierarchy' or 'lsp'. */
  confidence?: number;
}

export interface BaseNode {
  id: string;
  label: string;
  fsPath?: string;
  // Optional source/range for UI “open at”
  source?: string;
  range?: { line: number; col: number };
}

export interface ModuleNode extends BaseNode {
  kind: 'module';
  // UI state
  x?: number; y?: number;
  collapsed?: boolean;
  lspStatus?: 'ok' | 'partial' | 'nolsp';
  heuristicCalls?: boolean;
}

export interface ClassNode extends BaseNode {
  kind: 'class';
  parent: string;        // module id
  docked?: boolean;
  dx?: number; dy?: number;
  snippet?: string;
}

export interface FuncNode extends BaseNode {
  kind: 'func';
  parent: string;        // module id or class id
  docked?: boolean;
  x?: number; y?: number; // free position when undocked
  dx?: number; dy?: number; // offset when docked
  _w?: number;           // measured width for layout
  snippet?: string;
}

export type GraphNode = ModuleNode | ClassNode | FuncNode;

export interface GraphArtifacts {
  nodes: GraphNode[];
  edges: Edge[];
}

export type ParseStatus = 'ok' | 'partial' | 'nolsp';

export interface Diagnostic {
  file: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
}

export interface ParseResult extends GraphArtifacts {
  status: ParseStatus;
  diagnostics: Diagnostic[];
}

export interface Totals {
  modules: number;
  funcs: number;
}
