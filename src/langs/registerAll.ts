// src/langs/registerAll.ts
import { register } from './registry';
import { pythonAdapter } from './python';
import { tsAdapter } from './typescript';
import { goAdapter } from './go';
import { makeTemplateAdapter } from './template';
import * as fs from 'fs';
import * as path from 'path';
import { noteWasm } from '../core/diag';

export function registerAllLanguages(){
  // TS/JS + Python handle their own fallbacks and log WASM status inside init()
  register(pythonAdapter);
  register(tsAdapter);

  // Go: log whether grammar exists (adapter also falls back safely)
  try {
    const goWasm = path.join(__dirname, '../vendor', 'tree-sitter-go.wasm');
    const hasGo = fs.existsSync(goWasm);
    noteWasm('go', hasGo, goWasm, hasGo ? undefined : 'adapter will regex-fallback');
  } catch {}
  register(goAdapter);

  // Example: register(makeTemplateAdapter());
}
