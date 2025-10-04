// src/core/types.ts
export type Confidence = 'regex' | 'ts' | 'ast' | 'lsp';

export type Range = { line: number; col: number };

export type NodeKind = 'module' | 'class' | 'func';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  fsPath?: string;
  parent?: string;
  docked?: boolean;
  snippet?: string;
  range?: Range;
  source?: string; // module only
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'call' | 'import';
  confidence: Confidence;
}

export interface FileFacts {
  uri: string;
  lang: string;
  structs: GraphNode[];
  rawImports: string[];         // raw specifiers as written
  callsByFuncId: Map<string, Set<string>>; // bare call identifiers per func (no dots)
}
