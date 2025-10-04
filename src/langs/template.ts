// src/langs/template.ts
// Copy this file to new adapters, e.g. src/langs/ruby.ts, and fill in the TODOs.

import type * as T from '../core/types';
import { LangAdapter } from './registry';

const Parser: any = require('web-tree-sitter'); // CommonJS import works with our tsconfig
// Pick the export that actually has .init(); otherwise use whatever exists (Node may not need init).
const WTS: any = (Parser?.init ? Parser
  : (Parser?.default?.init ? Parser.default
  : (Parser?.default ?? Parser)));
const maybeInit = (typeof WTS?.init === 'function') ? WTS.init.bind(WTS) : null;

import * as fs from 'fs';
import * as path from 'path';

// -------------------- Adapter Config (EDIT THESE) --------------------
const ID = 'xx';                      // e.g. 'rb', 'go'
const EXTS = ['.xx'];                 // e.g. ['.rb'] or ['.go']
const WASM_FILE = 'tree-sitter-xx.wasm'; // put wasm in src/vendor/ (or leave empty to go regex-only)
const HAS_AST = true;                 // set to false to ship regex-only first

// Basic language regexes for fallback parsing:
const RE_CLASS = /^\s*class\s+([A-Za-z_]\w*)/m;             // TODO: replace
const RE_FUNC  = /^\s*def\s+([A-Za-z_]\w*)\s*\(/m;          // TODO: replace
const RE_IMPORTS = /^(?:import\s+.+|from\s+.+\s+import\s+.+)$/mg; // TODO: replace
// --------------------------------------------------------------------

let LANG: any | null = null;
let parserReady = false;

async function ensureParser() {
  if (!HAS_AST) return;
  if (parserReady) return;
  if (maybeInit) { await maybeInit(); }
  const wasmPath = path.join(__dirname, '../vendor', WASM_FILE);
  if (!fs.existsSync(wasmPath)) throw new Error(`Missing grammar: ${wasmPath}`);
  // In Node, pass bytes/Buffer to Language.load.
  LANG = await WTS.Language.load(fs.readFileSync(wasmPath));
  parserReady = true;
}

function idHash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function snippet(lines: string[], start: number, count = 20) {
  const end = Math.min(lines.length, start + count);
  return lines.slice(start, end).join('\n');
}

export const makeTemplateAdapter = (): LangAdapter => ({
  id: ID,
  exts: EXTS,

  // 1) Parse structs (module/classes/functions) + collect rawImports + local call tokens
  async parseStructs(src: string, uri: string): Promise<T.FileFacts> {
    // Always create a module node
    const rel = uri.replace(/\\/g, '/');
    const modId = `mod_${idHash(rel)}`;
    const nodes: T.GraphNode[] = [
      { id: modId, kind: 'module', label: rel, fsPath: uri, source: src }
    ];
    const rawImports: string[] = [];
    const callsByFuncId = new Map<string, Set<string>>();
    const lines = src.split(/\r?\n/);

    // Try AST, else fallback
    if (HAS_AST) {
      try {
        await ensureParser();
        const p = new WTS();
        p.setLanguage(LANG!);
        const tree = p.parse(src);

        // ---- AST WALK (EDIT FOR YOUR GRAMMAR) ----
        // Example: find classes, functions, and import-like nodes.
        const walk = (n: any, currentClassId?: string) => {
          switch (n.type) {
            // TODO: replace with your grammar node names:
            case 'class_definition': {
              const nameNode = n.childForFieldName?.('name') ?? n.child(1);
              const name = nameNode ? src.slice(nameNode.startIndex, nameNode.endIndex) : 'Class';
              const clsId = `cls_${idHash(rel + ':' + name)}`;
              const line = (nameNode ?? n).startPosition.row;
              nodes.push({
                id: clsId, kind: 'class', label: `class ${name}`, parent: modId, docked: true,
                fsPath: uri, range: { line, col: 0 }, snippet: snippet(lines, line)
              });
              n.children?.forEach((c: any) => walk(c, clsId));
              return;
            }
            case 'function_definition': {
              const nameNode = n.childForFieldName?.('name') ?? n.child(1);
              const name = nameNode ? src.slice(nameNode.startIndex, nameNode.endIndex) : 'func';
              const line = (nameNode ?? n).startPosition.row;
              const fnId = `fn_${idHash(rel + ':' + (currentClassId ?? modId) + ':' + name + ':' + line)}`;
              const display = currentClassId
                ? `${(nodes.find(nn => nn.id === currentClassId)?.label || 'class ?').replace(/^class\s+/, '')}.${name}`
                : name;
              nodes.push({
                id: fnId, kind: 'func', label: `def ${display}()`, parent: currentClassId ?? modId,
                docked: true, fsPath: uri, range: { line, col: 0 }, snippet: snippet(lines, line)
              });

              // Collect bare call identifiers (non-member calls)
              const names = new Set<string>();
              // TODO: customize for your grammar: find call nodes and extract callee identifiers.
              n.descendantsOfType?.('call')?.forEach((call: any) => {
                const func = call.child(0);
                if (!func) return;
                if (func.type === 'attribute') return; // skip foo.bar()
                const text = src.slice(func.startIndex, func.endIndex);
                if (/^[A-Za-z_]\w*$/.test(text)) names.add(text);
              });
              callsByFuncId.set(fnId, names);
              n.children?.forEach((c: any) => walk(c, currentClassId));
              return;
            }
            // imports
            case 'import_statement':
            case 'import_from_statement': {
              rawImports.push(src.slice(n.startIndex, n.endIndex));
              break;
            }
          }
          n.children?.forEach((c: any) => walk(c, currentClassId));
        };

        walk(tree.rootNode);
        return { uri, lang: ID, structs: nodes, rawImports, callsByFuncId };
      } catch {
        // fall through to regex
      }
    }

    // ---- REGEX FALLBACK (EDIT THESE) ----
    // imports
    const im = src.match(RE_IMPORTS) || [];
    rawImports.push(...im.map(s => s.trim()));

    // naive class/func detection
    lines.forEach((L, i) => {
      const cm = RE_CLASS.exec(L);
      if (cm) {
        const clsId = `cls_${idHash(rel + ':' + cm[1])}`;
        nodes.push({
          id: clsId, kind: 'class', label: `class ${cm[1]}`, parent: modId, docked: true,
          fsPath: uri, range: { line: i, col: 0 }, snippet: snippet(lines, i)
        });
        return;
      }
      const fm = RE_FUNC.exec(L);
      if (fm) {
        const fnId = `fn_${idHash(rel + ':' + fm[1] + ':' + i)}`;
        nodes.push({
          id: fnId, kind: 'func', label: `def ${fm[1]}()`, parent: modId, docked: true,
          fsPath: uri, range: { line: i, col: 0 }, snippet: snippet(lines, i)
        });
        // ultra-simple call token harvest inside same line (off by default)
        callsByFuncId.set(fnId, new Set<string>());
      }
    });

    return { uri, lang: ID, structs: nodes, rawImports, callsByFuncId };
  },

  // 2) Resolve imports → file paths (best-effort)
  async resolveImports(facts, workspaceRoot) {
    const out = new Map<string, string>();
    // TODO: turn rawImports into file paths (if your language uses relative paths, module paths, etc.)
    // For first cut, return empty map and let DepViz draw unresolved import edges as unknown modules.
    return out;
  },

  // 3) Resolve calls (local-first)
  async resolveCalls(facts, nodes) {
    const edges: Pick<T.GraphEdge, 'from' | 'to' | 'type' | 'confidence'>[] = [];
    const funcs = nodes.filter(n => n.kind === 'func');
    const byBare = new Map<string, string[]>();
    for (const f of funcs) {
      const bare = (f.label || '').replace(/^.*\s+([A-Za-z_]\w*)\(\).*$/, '$1');
      if (!byBare.has(bare)) byBare.set(bare, []);
      byBare.get(bare)!.push(f.id);
    }
    for (const [fromId, names] of facts.callsByFuncId) {
      for (const name of names) {
        const local = byBare.get(name);
        if (local && local.length) edges.push({ from: fromId, to: local[0], type: 'call', confidence: HAS_AST ? 'ast' : 'regex' });
      }
    }
    return edges;
  }
});
