// src/langs/python.ts
const path = require('path') as typeof import('path');
import * as fs from 'fs';
import { FileFacts, GraphNode, GraphEdge } from '../core/types';
import { LangAdapter } from './registry';
import { fnv1a32 } from '../core/hash';
import { stripStringsAndCommentsPy, normalizeContinuationsPy } from '../core/text';
import { loadTreeSitter } from '../core/wasm';

let PY_LANG: any | null = null;
let ParserCtor: any | null = null;

const idHash = fnv1a32;
const normalizePosix = (p: string) => p.replace(/\\/g, '/');
const snippet = (lines: string[], start: number, count = 20) => lines.slice(start, Math.min(lines.length, start + count)).join('\n');

const RE_CLASS = /^\s*class\s+([A-Za-z_]\w*)\s*[:(]?/;
const RE_FUNC  = /^\s*def\s+([A-Za-z_]\w*)\s*\(/;

async function init() {
  if (PY_LANG && ParserCtor) return;
  const ts = await loadTreeSitter('py', 'tree-sitter-python.wasm');
  if (!ts) { PY_LANG = null; ParserCtor = null; return; }
  PY_LANG = ts.Language;
  ParserCtor = ts.ParserCtor;
}

function parseStructsRegex(src: string, uri: string): FileFacts {
  const rel = normalizePosix(uri);
  const nodes: GraphNode[] = [{ id: `mod_${idHash(rel)}`, kind: 'module', label: rel, fsPath: uri, source: src }];
  const callsByFuncId = new Map<string, Set<string>>();
  const rawImports: string[] = [];

  const T0 = normalizeContinuationsPy(stripStringsAndCommentsPy(src));
  const impPy = /(?:^|\n)\s*(?:from\s+([A-Za-z0-9_.]+|(?:\.+[A-Za-z0-9_.]*))\s+import\s+([A-Za-z0-9_,\s\*\.]+)|import\s+([A-Za-z0-9_.]+)(?:\s+as\s+\w+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = impPy.exec(T0))) rawImports.push(m[0]);

  const modId = nodes[0].id;
  const lines = src.split(/\r?\n/);
  const classStack: Array<{ id: string; name: string; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const indent = (L.match(/^\s*/)?.[0].length) ?? 0;
    while (classStack.length && indent <= classStack[classStack.length - 1].indent) classStack.pop();

    const cm = RE_CLASS.exec(L);
    if (cm) {
      const name = cm[1];
      const clsId = `cls_${idHash(rel + ':' + name)}`;
      nodes.push({ id: clsId, kind: 'class', label: `class ${name}`, parent: modId, docked: true,
        fsPath: uri, range: { line: i, col: 0 }, snippet: snippet(lines, i) });
      classStack.push({ id: clsId, name, indent });
      continue;
    }

    const fm = RE_FUNC.exec(L);
    if (fm) {
      const bare = fm[1];
      const parent = classStack.length ? classStack[classStack.length - 1] : null;
      const qual = parent ? `${parent.name}.${bare}` : bare;
      const fnId = `fn_${idHash(rel + ':' + (parent?.id ?? modId) + ':' + qual + ':' + i)}`;
      nodes.push({ id: fnId, kind: 'func', label: `def ${qual}()`, parent: parent?.id ?? modId, docked: true,
        fsPath: uri, range: { line: i, col: 0 }, snippet: snippet(lines, i) });
      callsByFuncId.set(fnId, new Set<string>());
    }
  }

  return { uri, lang: 'py', structs: nodes, rawImports, callsByFuncId };
}

function guessPythonImportToPath(spec: string, fileDir: string, workspaceRoot: string): string | null {
  const norm = (p: string) => normalizePosix(path.normalize(p));
  const tryCands = (core: string) => {
    const cands = [core + '.py', path.join(core, '__init__.py')];
    for (const c of cands) { try { if (fs.existsSync(c)) return norm(c); } catch {} }
    return null;
  };
  if (!spec) return null;
  if (spec.startsWith('.')) {
    const dots = (spec.match(/^\.+/)?.[0].length) ?? 0;
    const rest = spec.slice(dots).replace(/^\./, '');
    const pops = Math.max(0, dots - 1);
    const baseParts = fileDir.split(path.sep);
    const cut = baseParts.slice(0, Math.max(0, baseParts.length - pops));
    const joined = path.join(...cut, ...(rest ? rest.split('.').filter(Boolean) : []));
    return tryCands(joined);
  }
  const absCore = path.join(workspaceRoot, ...spec.split('.'));
  const hit = tryCands(absCore);
  if (hit) return hit;
  return tryCands(path.join(fileDir, ...spec.split('.')));
}

export const pythonAdapter: LangAdapter = {
  id: 'py',
  exts: ['.py'],

  async parseStructs(src: string, uri: string): Promise<FileFacts> {
    await init();
    if (!PY_LANG || !ParserCtor) return parseStructsRegex(src, uri);

    try {
      const parser = new ParserCtor();
      parser.setLanguage(PY_LANG);
      const tree = parser.parse(src);

      const nodes: GraphNode[] = [];
      const callsByFuncId = new Map<string, Set<string>>();
      const rawImports: string[] = [];

      const rel = normalizePosix(uri);
      const lines = src.split(/\r?\n/);
      const modId = `mod_${idHash(rel)}`;
      nodes.push({ id: modId, kind: 'module', label: rel, fsPath: uri, source: src });

      const pushFunc = (qualName: string, row: number, parent: string) => {
        const fnId = `fn_${idHash(rel + ':' + parent + ':' + qualName + ':' + row)}`;
        nodes.push({
          id: fnId, kind: 'func', label: `def ${qualName}()`, parent, docked: true,
          fsPath: uri, range: { line: row, col: 0 }, snippet: snippet(lines, row)
        });
        const names = new Set<string>();
        callsByFuncId.set(fnId, names);
        return fnId;
      };

      const walk = (node: any, parentClassId?: string, parentClassName?: string) => {
        const t = node.type;

        if (t === 'import_statement' || t === 'import_from_statement') {
          rawImports.push(src.slice(node.startIndex, node.endIndex));
        }

        if (t === 'class_definition') {
          const nameNode = node.childForFieldName('name');
          const name = nameNode ? src.slice(nameNode.startIndex, nameNode.endIndex) : 'Class';
          const clsId = `cls_${idHash(rel + ':' + name)}`;
          const line = (nameNode ? nameNode.startPosition.row : node.startPosition.row) | 0;

          nodes.push({
            id: clsId, kind: 'class', label: `class ${name}`, parent: modId, docked: true,
            fsPath: uri, range: { line, col: 0 }, snippet: snippet(lines, line)
          });

          node.children?.forEach((ch: any) => walk(ch, clsId, name));
          return;
        }

        if (t === 'function_definition') {
          const nameNode = node.childForFieldName('name');
          const name = nameNode ? src.slice(nameNode.startIndex, nameNode.endIndex) : 'func';
          const row = (nameNode ? nameNode.startPosition.row : node.startPosition.row) | 0;
          const qual = parentClassName ? `${parentClassName}.${name}` : name;
          const fnId = pushFunc(qual, row, parentClassId || modId);

          const seen = callsByFuncId.get(fnId)!;
          if (typeof (node as any).descendantsOfType === 'function') {
            (node as any).descendantsOfType('call').forEach((call: any) => {
              const callee = call.child(0);
              if (!callee) return;
              if (callee.type === 'attribute') return;
              const text = src.slice(callee.startIndex, callee.endIndex);
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) seen.add(text);
            });
          }

          node.children?.forEach((ch: any) => walk(ch, parentClassId, parentClassName));
          return;
        }

        node.children?.forEach((ch: any) => walk(ch, parentClassId, parentClassName));
      };

      walk(tree.rootNode);

      if (!nodes.length) {
        return parseStructsRegex(src, uri);
      }
      return { uri, lang: 'py', structs: nodes, rawImports, callsByFuncId };
    } catch {
      return parseStructsRegex(src, uri);
    }
  },

  async resolveImports(facts: FileFacts, workspaceRoot: string) {
    const out = new Map<string, string>();
    const moduleNode = facts.structs.find(n => n.kind === 'module');
    const src = moduleNode?.source || '';
    const fileDir = path.dirname(facts.uri);

    const T0 = normalizeContinuationsPy(stripStringsAndCommentsPy(src));
    const impPy = /(?:^|\n)\s*(?:from\s+([A-Za-z0-9_.]+|(?:\.+[A-Za-z0-9_.]*))\s+import\s+([A-Za-z0-9_,\s\*\.]+)|import\s+([A-Za-z0-9_.]+)(?:\s+as\s+\w+)?)/g;

    let m: RegExpExecArray | null;
    while ((m = impPy.exec(T0))) {
      const spec = (m[1] ?? m[3] ?? '').trim();
      if (!spec) continue;
      const resolved = guessPythonImportToPath(spec, fileDir, workspaceRoot);
      if (resolved) out.set(spec, resolved);
    }
    return out;
  },

  async resolveCalls(facts: FileFacts, nodes: GraphNode[]) {
    const edges: Pick<GraphEdge, 'from' | 'to' | 'type' | 'confidence'>[] = [];
    const funcs = nodes.filter(n => n.kind === 'func');

    const byBare = new Map<string, string[]>();
    for (const f of funcs) {
      const m = /([A-Za-z_][A-Za-z0-9_]*)\(\)/.exec(f.label || '');
      const bare = m ? m[1] : null;
      if (!bare) continue;
      if (!byBare.has(bare)) byBare.set(bare, []);
      byBare.get(bare)!.push(f.id);
    }

    for (const [fromId, names] of facts.callsByFuncId) {
      for (const name of names) {
        const local = byBare.get(name);
        if (local && local.length) edges.push({ from: fromId, to: local[0], type: 'call', confidence: 'regex' });
      }
    }
    return edges;
  }
};
