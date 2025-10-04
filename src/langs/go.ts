// src/langs/go.ts
import type { FileFacts, GraphNode, GraphEdge } from '../core/types';
import type { LangAdapter } from './registry';
import * as fs from 'fs';
import * as path from 'path';
import { loadTreeSitter } from '../core/wasm';

let GO_LANG: any | null = null;
let ParserCtor: any | null = null;
let ready = false;

const idHash = (s: string) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8,'0');
};
const norm = (p: string) => p.replace(/\\/g,'/');
const snippet = (lines: string[], start: number, n=20) => lines.slice(start, Math.min(lines.length, start+n)).join('\n');

async function init() {
  if (ready) return;
  const ts = await loadTreeSitter('go', 'tree-sitter-go.wasm');
  if (!ts) { ready = false; return; }
  ParserCtor = ts.ParserCtor;
  GO_LANG = ts.Language;
  ready = true;
}

function receiverTypeText(src: string, recvNode: any): string | null {
  if (!recvNode) return null;
  const t = recvNode.descendantsOfType?.('type_identifier')?.[0];
  if (!t) return null;
  const raw = src.slice(t.startIndex, t.endIndex);
  const last = raw.split('.').pop() || raw;
  return last.replace(/^\*+/, '');
}

function parseStructsRegex(src: string, uri: string): FileFacts {
  const rel = norm(uri);
  const modId = `mod_${idHash(rel)}`;
  const nodes: GraphNode[] = [{ id: modId, kind: 'module', label: rel, fsPath: uri, source: src }];
  const callsByFuncId = new Map<string, Set<string>>();
  const rawImports: string[] = (src.match(/^\s*import\s+(?:\(\s*[\s\S]*?\)|".+?")/mg) || []);
  const lines = src.split(/\r?\n/);

  const RE_FN = /^\s*func\s+([A-Za-z_]\w*)\s*\(/;
  lines.forEach((L, i) => {
    const m = RE_FN.exec(L);
    if (m) {
      const id = `fn_${idHash(rel + ':' + m[1] + ':' + i)}`;
      nodes.push({
        id, kind:'func', label:`def ${m[1]}()`, parent: modId, docked:true,
        fsPath: uri, range:{line:i,col:0}, snippet: snippet(lines,i)
      });
      callsByFuncId.set(id, new Set());
    }
  });

  return { uri, lang: 'go', structs: nodes, rawImports, callsByFuncId };
}

export const goAdapter: LangAdapter = {
  id: 'go',
  exts: ['.go'],

  async parseStructs(src: string, uri: string): Promise<FileFacts> {
    await init();
    if (!ready || !GO_LANG || !ParserCtor) {
      return parseStructsRegex(src, uri);
    }

    const parser = new ParserCtor();
    parser.setLanguage(GO_LANG);

    const tree = parser.parse(src);
    const nodes: GraphNode[] = [];
    const callsByFuncId = new Map<string, Set<string>>();
    const rawImports: string[] = [];

    const rel = norm(uri);
    const modId = `mod_${idHash(rel)}`;
    nodes.push({ id: modId, kind: 'module', label: rel, fsPath: uri, source: src });

    const lines = src.split(/\r?\n/);
    const textOf = (n: any) => src.slice(n.startIndex, n.endIndex);

    const typeIdByName = new Map<string, string>();

    tree.rootNode.descendantsOfType?.('type_declaration')?.forEach((td: any) => {
      td.descendantsOfType?.('type_spec')?.forEach((ts: any) => {
        const name = ts.childForFieldName?.('name');
        const tnode = ts.childForFieldName?.('type');
        if (!name || !tnode) return;
        const nTxt = textOf(name);
        const kindTxt = tnode.type;
        if (kindTxt !== 'struct_type' && kindTxt !== 'interface_type') return;
        const clsId = `cls_${idHash(rel + ':' + nTxt)}`;
        const line = name.startPosition.row;
        nodes.push({
          id: clsId, kind: 'class',
          label: `type ${nTxt} ${kindTxt === 'struct_type' ? 'struct' : 'interface'}`,
          parent: modId, docked: true, fsPath: uri,
          range: { line, col: name.startPosition.column },
          snippet: snippet(lines, line)
        });
        typeIdByName.set(nTxt, clsId);
      });
    });

    tree.rootNode.descendantsOfType?.('import_spec')?.forEach((is: any) => {
      rawImports.push(textOf(is));
    });

    const addFn = (display: string, parentId: string, row: number, col: number) => {
      const fnId = `fn_${idHash(rel + ':' + parentId + ':' + display + ':' + row)}`;
      nodes.push({
        id: fnId, kind: 'func', label: `def ${display}()`,
        parent: parentId, docked: true, fsPath: uri,
        range: { line: row, col }, snippet: snippet(lines, row)
      });
      const names = new Set<string>();
      callsByFuncId.set(fnId, names);
      return fnId;
    };

    const harvestCalls = (fnNode: any, fnId: string) => {
      fnNode.descendantsOfType?.('call_expression')?.forEach((call: any) => {
        const funcNode = call.childForFieldName?.('function') || call.child(0);
        if (!funcNode) return;
        if (funcNode.type === 'selector_expression') return; // skip x.y()
        if (funcNode.type !== 'identifier') return;
        const txt = textOf(funcNode);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(txt)) callsByFuncId.get(fnId)!.add(txt);
      });
    };

    tree.rootNode.descendantsOfType?.('function_declaration')?.forEach((fn: any) => {
      const name = fn.childForFieldName?.('name');
      if (!name) return;
      const row = name.startPosition.row, col = name.startPosition.column;
      const fnId = addFn(textOf(name), modId, row, col);
      harvestCalls(fn, fnId);
    });

    tree.rootNode.descendantsOfType?.('method_declaration')?.forEach((md: any) => {
      const name = md.childForFieldName?.('name');
      const recv = md.childForFieldName?.('receiver');
      if (!name) return;
      const base = receiverTypeText(src, recv);
      const qual = base ? `${base}.${textOf(name)}` : textOf(name);
      const parent = (base && typeIdByName.get(base)) || modId;
      const row = name.startPosition.row, col = name.startPosition.column;
      const fnId = addFn(qual, parent, row, col);
      harvestCalls(md, fnId);
    });

    return { uri, lang: 'go', structs: nodes, rawImports, callsByFuncId };
  },

  async resolveImports(facts: FileFacts, workspaceRoot: string) {
    const out = new Map<string, string>();
    const src = facts.structs.find(n=>n.kind==='module')?.source || '';
    const impRe = /import\s*(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g;
    const quoted = /"([^"]+)"/g;

    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = impRe.exec(src))) {
      const block = m[1], single = m[2];
      if (single) seen.add(single);
      if (block) { let k: RegExpExecArray | null; while ((k = quoted.exec(block))) seen.add(k[1]); }
    }

    const tryFolder = (pkgPath: string): string | null => {
      const abs = path.resolve(workspaceRoot, pkgPath);
      try {
        if (!fs.existsSync(abs)) return null;
        const hasGo = (fs.readdirSync(abs) || []).some(f => f.endsWith('.go'));
        return hasGo ? norm(abs) : null;
      } catch { return null; }
    };

    for (const spec of seen) {
      if (!spec) continue;
      const hit = tryFolder(spec);
      if (hit) out.set(spec, hit + '/');
    }
    return out;
  },

  async resolveCalls(_facts: FileFacts, _nodes: GraphNode[]): Promise<Pick<GraphEdge,'from'|'to'|'type'|'confidence'>[]> {
    return [];
  }
};
