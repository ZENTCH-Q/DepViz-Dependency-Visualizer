// src/langs/registry.ts
import { FileFacts, GraphEdge, GraphNode } from '../core/types';

export interface LangAdapter {
  id: string;                             // 'py', 'ts', 'js', etc.
  exts: string[];                         // ['.py'] or ['.ts','.tsx','.js','.jsx']
  parseStructs(src: string, uri: string): Promise<FileFacts>;
  resolveImports?(facts: FileFacts, workspaceRoot: string): Promise<Map<string, string>>; // spec -> resolved path
  resolveCalls?(
    facts: FileFacts,
    nodes: GraphNode[],
    importMap: Map<string,string>,
    workspaceRoot?: string
  ): Promise<Pick<GraphEdge,'from'|'to'|'type'|'confidence'>[]>;
}

const REGISTRY: LangAdapter[] = [];

export function register(adapter: LangAdapter){ REGISTRY.push(adapter); }

export function pickByExt(ext: string): LangAdapter | undefined {
  const e = ext.toLowerCase();
  return REGISTRY.find(a => a.exts.includes(e));
}

export function listAdapters(){ return [...REGISTRY]; }
