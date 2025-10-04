// src/langs/typescript.ts
import type { FileFacts, GraphEdge, GraphNode } from '../core/types';
import type { LangAdapter } from './registry';
import * as path from 'path';
import * as fs from 'fs';
import { bareFromLabel } from '../core/labels';
import { loadTsPathAliases, applyPathAliases } from './tsconfigPaths';
import { resolveImportsWithTs, resolveCallsWithTs, getProgram } from './tsc';
import { loadTreeSitter } from '../core/wasm';

let LANG_TS: any | null = null;
let LANG_JS: any | null = null;
let ParserCtor: any | null = null;
let ready = false;

const norm = (p: string) => p.replace(/\\/g, '/');
const idHash = (s: string) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
};
const snippet = (lines: string[], start: number, count = 20) =>
  lines.slice(start, Math.min(lines.length, start + count)).join('\n');

type TSLike = 'ts' | 'tsx' | 'js' | 'jsx';
function pickLangByExt(ext: TSLike) { return (ext === 'ts' || ext === 'tsx') ? LANG_TS : LANG_JS; }
function extOf(p: string): TSLike {
  const m = /\.([a-z0-9_.-]+)$/i.exec(p);
  const e = (m ? m[1].toLowerCase() : '') as TSLike;
  return (e === 'tsx' || e === 'jsx' || e === 'ts' || e === 'js') ? e : 'ts';
}

async function init() {
  if (ready) return;
  const ts1 = await loadTreeSitter('ts/js', 'tree-sitter-typescript.wasm');
  const ts2 = await loadTreeSitter('ts/js', 'tree-sitter-javascript.wasm');
  if (!ts1 || !ts2) { ready = false; LANG_TS=null; LANG_JS=null; ParserCtor=null; return; }
  ParserCtor = ts1.ParserCtor; // same ctor works for both grammars
  LANG_TS = ts1.Language;
  LANG_JS = ts2.Language;
  ready = true;
}

/* ----------------------------- REGEX FALLBACK ----------------------------- */
function parseStructsRegex(src: string, uri: string): FileFacts {
  const rel = norm(uri);
  const modId = `mod_${idHash(rel)}`;
  const nodes: GraphNode[] = [{ id: modId, kind: 'module', label: rel, fsPath: uri, source: src }];
  const rawImports: string[] = [];
  const callsByFuncId = new Map<string, Set<string>>();
  const lines = src.split(/\r?\n/);

  const impTs = /(?:^|\n)\s*(?:import\s+(?:[^'"]+)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|export\s+[^;]+?\s+from\s+['"]([^'"]+)['"])/g;
  let m: RegExpExecArray | null;
  while ((m = impTs.exec(src))) rawImports.push(m[0]);

  const RE_FN_DECL = /^\s*(?:export\s+)?function\s+([A-Za-z_]\w*)\s*\(/;
  const RE_VAR_FN  = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>)/;
  const RE_CLASS   = /^\s*class\s+([A-Za-z_]\w*)/;

  const classStack: Array<{ id: string; name: string; indent: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const indent = (L.match(/^\s*/)?.[0].length) ?? 0;
    while (classStack.length && indent <= classStack[classStack.length - 1].indent) classStack.pop();

    const cm = RE_CLASS.exec(L);
    if (cm) {
      const clsId = `cls_${idHash(rel + ':' + cm[1])}`;
      nodes.push({ id: clsId, kind: 'class', label: `class ${cm[1]}`, parent: modId, docked: true, fsPath: uri, range: { line: i, col: 0 }, snippet: snippet(lines, i) });
      classStack.push({ id: clsId, name: cm[1], indent });
      continue;
    }

    const fm = RE_FN_DECL.exec(L) || RE_VAR_FN.exec(L);
    if (fm) {
      const bare = fm[1];
      const parent = classStack.length ? classStack[classStack.length - 1] : null;
      const qual = parent ? `${parent.name}.${bare}` : bare;
      const fnId = `fn_${idHash(rel + ':' + (parent?.id ?? modId) + ':' + qual + ':' + i)}`;
      nodes.push({ id: fnId, kind: 'func', label: `def ${qual}()`, parent: parent?.id ?? modId, docked: true, fsPath: uri, range: { line: i, col: 0 }, snippet: snippet(lines, i) });
      callsByFuncId.set(fnId, new Set<string>());
    }
  }

  return { uri, lang: 'ts', structs: nodes, rawImports, callsByFuncId };
}

/* ------------------------------ MAIN ADAPTER ------------------------------ */
export const tsAdapter: LangAdapter = {
  id: 'ts',
  exts: ['.ts', '.tsx', '.js', '.jsx'],

  async parseStructs(src: string, uri: string): Promise<FileFacts> {
    await init();
    if (!ready || !ParserCtor) return parseStructsRegex(src, uri);

    const ext = extOf(uri);
    const lang = pickLangByExt(ext);
    if (!lang) return parseStructsRegex(src, uri);

    const parser = new ParserCtor();
    parser.setLanguage(lang);

    const tree = parser.parse(src);
    const nodes: GraphNode[] = [];

    const rel = norm(uri);
    const modId = `mod_${idHash(rel)}`;
    nodes.push({ id: modId, kind: 'module', label: rel, fsPath: uri, source: src });

    const lines = src.split(/\r?\n/);
    const callsByFuncId = new Map<string, Set<string>>();
    const rawImports: string[] = [];

    const root: any = tree.rootNode;
    const textOf = (n: any) => src.slice(n.startIndex, n.endIndex);

    root.descendantsOfType?.('import_statement')?.forEach((n: any) => { rawImports.push(textOf(n)); });

    root.descendantsOfType?.('class_declaration')?.forEach((cls: any) => {
      const nameNode = cls.childForFieldName?.('name') || cls.child(1);
      const name = nameNode ? textOf(nameNode) : 'Class';
      const line = nameNode ? nameNode.startPosition.row : cls.startPosition.row;
      const clsId = `cls_${idHash(rel + ':' + name)}`;
      nodes.push({ id: clsId, kind: 'class', label: `class ${name}`, parent: modId, docked: true,
        fsPath: uri, range: { line, col: 0 }, snippet: snippet(lines, line) });

      cls.descendantsOfType?.('method_definition')?.forEach((m: any) => {
        const n = m.childForFieldName?.('name');
        if (!n) return;
        const mName = textOf(n);
        const line2 = n.startPosition.row;
        const fnId = `fn_${idHash(rel + ':' + name + '.' + mName + ':' + line2)}`;
        nodes.push({ id: fnId, kind: 'func', label: `def ${name}.${mName}()`, parent: clsId, docked: true,
          fsPath: uri, range: { line: line2, col: n.startPosition.column }, snippet: snippet(lines, line2) });

        const names = new Set<string>();
        m.descendantsOfType?.('call_expression')?.forEach((call: any) => {
          const callee = call.childForFieldName?.('function') || call.child(0);
          if (!callee) return;
          if (callee.type === 'member_expression') return;
          const txt = textOf(callee);
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(txt)) names.add(txt);
        });
        callsByFuncId.set(fnId, names);
      });
    });

    root.descendantsOfType?.('function_declaration')?.forEach((fn: any) => {
      const nameNode = fn.childForFieldName?.('name') || fn.child(1);
      if (!nameNode) return;
      const name = textOf(nameNode);
      const line = nameNode.startPosition.row;
      const fnId = `fn_${idHash(rel + ':' + name + ':' + line)}`;
      nodes.push({ id: fnId, kind: 'func', label: `def ${name}()`, parent: modId, docked: true,
        fsPath: uri, range: { line, col: nameNode.startPosition.column }, snippet: snippet(lines, line) });

      const names = new Set<string>();
      fn.descendantsOfType?.('call_expression')?.forEach((call: any) => {
        const callee = call.childForFieldName?.('function') || call.child(0);
        if (!callee) return;
        if (callee.type === 'member_expression') return;
        const txt = textOf(callee);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(txt)) names.add(txt);
      });
      callsByFuncId.set(fnId, names);
    });

    root.descendantsOfType?.('variable_declaration')?.forEach((vd: any) => {
      vd.descendantsOfType?.('variable_declarator')?.forEach((decl: any) => {
        const nameNode = decl.childForFieldName?.('name') || decl.child(0);
        const valueNode = decl.childForFieldName?.('value') || decl.child(2);
        if (!nameNode || !valueNode) return;
        const vname = textOf(nameNode);
        const isFn = valueNode.type === 'arrow_function' || valueNode.type === 'function';
        if (!isFn) return;

        const line = nameNode.startPosition.row;
        const fnId = `fn_${idHash(rel + ':' + vname + ':' + line)}`;
        nodes.push({ id: fnId, kind: 'func', label: `def ${vname}()`, parent: modId, docked: true,
          fsPath: uri, range: { line, col: nameNode.startPosition.column }, snippet: snippet(lines, line) });

        const names = new Set<string>();
        valueNode.descendantsOfType?.('call_expression')?.forEach((call: any) => {
          const callee = call.childForFieldName?.('function') || call.child(0);
          if (!callee) return;
          if (callee.type === 'member_expression') return;
          const txt = textOf(callee);
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(txt)) names.add(txt);
        });
        callsByFuncId.set(fnId, names);
      });
    });

    return { uri, lang: (ext === 'js' || ext === 'jsx') ? 'js' : 'ts', structs: nodes, rawImports, callsByFuncId };
  },

  async resolveImports(facts: FileFacts, workspaceRoot: string) {
    const viaTs = getProgram(workspaceRoot);
    if (viaTs) {
      try { return resolveImportsWithTs(facts.uri, workspaceRoot); } catch { /* fallback below */ }
    }
    const out = new Map<string, string>();
    const moduleSrc = facts.structs.find(n => n.kind === 'module')?.source || '';
    const baseDir = path.dirname(facts.uri);
    const aliases = loadTsPathAliases(workspaceRoot);

    const impTs = /(?:^|\n)\s*(?:import\s+(?:[^'"]+)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|export\s+[^;]+?\s+from\s+['"]([^'"]+)['"])/g;

    const tryExtensions = (abs: string) => {
      const order = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
      for (const suf of order) {
        const cand = abs + suf;
        if (fs.existsSync(cand)) return cand;
      }
      return null;
    };

    const nrm = (p: string) => norm(path.resolve(p));
    let m: RegExpExecArray | null;
    while ((m = impTs.exec(moduleSrc))) {
      const spec = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (!spec) continue;

      let resolved: string | null = null;
      if (spec.startsWith('.')) {
        resolved = tryExtensions(path.resolve(baseDir, spec));
      } else if (spec.startsWith('/')) {
        const abs = path.resolve(workspaceRoot, spec.replace(/^\/+/, ''));
        resolved = tryExtensions(abs);
      } else {
        const alias = applyPathAliases(spec, aliases);
        if (alias) resolved = tryExtensions(alias);
      }
      if (resolved) out.set(spec, nrm(resolved));
    }
    return out;
  },

  async resolveCalls(facts: FileFacts, nodes: GraphNode[], _importMap: Map<string, string>, workspaceRoot?: string) {
    if (workspaceRoot && getProgram(workspaceRoot)) {
      try { return resolveCallsWithTs(facts.uri, nodes, workspaceRoot); } catch { /* fall through */ }
    }

    const edges: Pick<GraphEdge, 'from' | 'to' | 'type' | 'confidence'>[] = [];
    const funcs = nodes.filter(n => n.kind === 'func');
    const byBare = new Map<string, string[]>();
    for (const f of funcs) {
      const bare = bareFromLabel(f.label);
      const arr = byBare.get(bare) || [];
      arr.push(f.id);
      byBare.set(bare, arr);
    }
    for (const [callerId, bareNames] of facts.callsByFuncId) {
      for (const b of bareNames) {
        const local = byBare.get(b);
        if (local && local.length) edges.push({ from: callerId, to: local[0], type: 'call', confidence: 'regex' });
      }
    }
    return edges;
  }
};
