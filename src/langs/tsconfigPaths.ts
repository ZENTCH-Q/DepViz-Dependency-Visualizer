// src/langs/tsconfigPaths.ts
import * as fs from 'fs';
import * as path from 'path';
const esc = (s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

export type PathAlias = { pattern: RegExp; replaceWith: string };

export function loadTsPathAliases(workspaceRoot: string): PathAlias[] {
  try {
    const tsconfig = path.join(workspaceRoot, 'tsconfig.json');
    if (!fs.existsSync(tsconfig)) return [];
    const json = JSON.parse(fs.readFileSync(tsconfig, 'utf8'));
    const baseUrl = path.resolve(workspaceRoot, json.compilerOptions?.baseUrl ?? '.');
    const paths = json.compilerOptions?.paths ?? {};
    const out: PathAlias[] = [];

    for (const [key, arr] of Object.entries(paths)) {
      const targets: string[] = Array.isArray(arr) ? (arr as string[]) : [];
      if (!targets.length) continue;

      // Support only first target for now (good enough for our purpose)
      const t0 = targets[0];

      // "alias/*"  ->  /^alias\/(.*)$/
      // "alias"    ->  /^alias$/
      const hasStar = key.includes('*');
      // escape everything first, then re-open the star to a capture group
      const keyEsc = esc(key).replace(/\\\*/g, '(.*)');
      const pat = new RegExp('^' + keyEsc + '$');
      const repl = path.resolve(baseUrl, hasStar ? t0.replace('*', '$1') : t0);

      out.push({ pattern: pat, replaceWith: repl });
    }
    return out;
  } catch {
    return [];
  }
}

export function applyPathAliases(spec: string, aliases: PathAlias[]): string | null {
  for (const a of aliases) {
    if (a.pattern.test(spec)) {
      return spec.replace(a.pattern, a.replaceWith);
    }
  }
  return null;
}
