#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SRC_DIR  = path.join(__dirname, '..', 'vendor');               // <-- correct path
const DEST_DIR = path.resolve(process.argv[process.argv.indexOf('--to')+1] || 'out/vendor');
const FILES = [
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-go.wasm'
];

fs.mkdirSync(DEST_DIR, { recursive: true });

for (const f of FILES) {
  const src = path.join(SRC_DIR, f);
  const dst = path.join(DEST_DIR, f);
  if (!fs.existsSync(src)) {
    console.warn(`[wasm] missing ${src} (skip)`);
    continue;
  }
  const same = fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size;
  if (!same) fs.copyFileSync(src, dst);
  console.log(`[wasm] ${same ? 'ok' : 'copied'} ${f} -> ${DEST_DIR}`);
}
