// src/core/wasm.ts
// One sane place to deal with web-tree-sitter’s weird exports + .init() + WASM bytes.
// Memoized per (langId, wasmRelPath). Logs only after successful load.

import * as fs from 'fs';
import * as path from 'path';
import { noteWasm } from './diag';

type Loaded = { ParserCtor: any; Language: any };
const CACHE = new Map<string, Loaded | null>();

function pickRoot(mod: any) {
  // Support CJS/ESM/bundled shapes without guessing.
  const root = mod?.default ?? mod;
  if (typeof root === 'function') return root;
  return root?.Parser ?? root;
}

function pickInit(mod: any): null | (() => Promise<void>) {
  // Try all the usual suspects, bind to their own object.
  const root = pickRoot(mod);
  const candidates = [mod, mod?.default, root, mod?.Parser, root?.Parser];
  for (const cand of candidates) {
    if (typeof cand?.init === 'function') return cand.init.bind(cand);
  }
  return null;
}

function pickLanguageCtor(mod: any) {
  const root = mod?.default ?? mod;
  return mod?.Language ?? root?.Language ?? root?.Parser?.Language ?? null;
}

export async function loadTreeSitter(langId: string, wasmRelPath: string): Promise<Loaded | null> {
  const key = `${langId}:${wasmRelPath}`;
  if (CACHE.has(key)) return CACHE.get(key)!;

  try {
    // Lazy import to avoid cost when regex-falling back.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ParserMod: any = require('web-tree-sitter');
    const Root: any = pickRoot(ParserMod);
    const initFn = pickInit(ParserMod);
    const LanguageCtor = pickLanguageCtor(ParserMod);

    if (initFn) {
      try { await initFn(); } catch { /* some Node builds don't need init */ }
    }
    if (!LanguageCtor || !Root) {
      noteWasm(langId, false, 'load', 'missing Language/Parser ctor');
      CACHE.set(key, null);
      return null;
    }

    const wasmPath = path.join(__dirname, '../vendor', wasmRelPath);
    if (!fs.existsSync(wasmPath)) {
      noteWasm(langId, false, wasmPath, 'missing');
      CACHE.set(key, null);
      return null;
    }

    const bytes = fs.readFileSync(wasmPath);
    const Language = await LanguageCtor.load(bytes); // Node: bytes Buffer is fine
    const out: Loaded = { ParserCtor: Root, Language };
    CACHE.set(key, out);
    noteWasm(langId, true, wasmPath);
    return out;
  } catch (e) {
    noteWasm(langId, false, 'load', e);
    CACHE.set(key, null);
    return null;
  }
}
