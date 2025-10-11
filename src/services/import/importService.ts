// src/services/import/importService.ts
import * as vscode from 'vscode';
import { RelativePattern } from 'vscode';
import { ParseService } from '../parse/parseService';
import { GraphArtifacts, Totals } from '../../shared/types';
import { normalizePath } from '../../shared/workspace';
import { extOf } from '../../shared/text';
import { dec, hash as hashString } from '../../shared/encoding';

type TotalsUpdater = (artifacts: GraphArtifacts) => void;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '.env',
  'dist', 'out', 'build', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox'
]);

const SKIP_EXTS = new Set([
  '.d.ts.map',
  '.min.js', '.map', '.lock',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.webp', '.bmp', '.tif', '.tiff', '.apng', '.avif',
  '.pdf', '.zip',
  '.pyc', '.pyo', '.whl', '.so', '.dll',
  '.class'
]);

export class ImportService {
  private readonly fingerprints = new Map<string, string>();
  private static readonly out = vscode.window.createOutputChannel('DepViz');
  private static lspWarnedThisSession = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parseService: ParseService,
    private readonly onArtifacts: TotalsUpdater,
    private readonly totals: Totals
  ) {}

  async importMany(uris: vscode.Uri[], panel: vscode.WebviewPanel, hardCap: number): Promise<void> {
    if (!uris.length) return;

    const cfg = vscode.workspace.getConfiguration('depviz');
    const include = (cfg.get<string[]>('includeGlobs') ?? ['**/*']).filter(Boolean);
    const exclude = (cfg.get<string[]>('excludeGlobs') ?? ['**/.git/**', '**/node_modules/**', '**/__pycache__/**']).filter(Boolean);
    const maxFiles = Math.max(1, hardCap | 0);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'DepViz: Importing...', cancellable: true },
      async (progress, token) => {
        const files = await this.findFilesFromRoots(uris, include, exclude, maxFiles);
        const totalFound = files.length;
        const capped = files.slice(0, maxFiles);
        if (totalFound > maxFiles) {
          vscode.window.showInformationMessage(
            `DepViz: Found ${totalFound} files, importing first ${maxFiles}. Adjust "depviz.maxFiles" to change.`
          );
        }

        const stats = { skippedBySize: 0, skippedByExt: 0 };
        let processed = 0, success = 0, failed = 0;

        const batch = 8;
        for (let i = 0; i < capped.length; i += batch) {
          if (token.isCancellationRequested) break;
          const slice = capped.slice(i, i + batch);
          const results = await Promise.all(slice.map(u => this.importUri(u, panel, token, stats)));
          for (const r of results) {
            processed += r.processed;
            success   += r.success;
            failed    += r.failed;
          }
          progress.report({ message: `${processed}/${capped.length}` });
        }

        vscode.window.showInformationMessage(
          `DepViz: Imported ${success} file(s). Failed ${failed}. ` +
          `Skipped: ${stats.skippedBySize} (size), ${stats.skippedByExt} (type).`
        );
      }
    );
  }

  async importUri(
    uri: vscode.Uri,
    panel: vscode.WebviewPanel,
    token?: vscode.CancellationToken,
    stats?: { skippedBySize: number; skippedByExt: number }
  ): Promise<{ processed: number; success: number; failed: number }> {
    try {
      if (token?.isCancellationRequested) return { processed: 0, success: 0, failed: 0 };

      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        const children = await vscode.workspace.fs.readDirectory(uri);
        let agg = { processed: 0, success: 0, failed: 0 };
        for (const [name] of children) {
          if (SKIP_DIRS.has(name)) continue;
          const r = await this.importUri(vscode.Uri.joinPath(uri, name), panel, token, stats);
          agg.processed += r.processed; agg.success += r.success; agg.failed += r.failed;
        }
        return agg;
      }

      // Size + type filters
      if (stat.size && stat.size > this.currentMaxFileSize()) {
        if (stats) stats.skippedBySize++;
        return { processed: 1, success: 0, failed: 0 };
      }
      if (SKIP_EXTS.has(extOf(uri.path))) {
        if (stats) stats.skippedByExt++;
        return { processed: 1, success: 0, failed: 0 };
      }

      const content = await vscode.workspace.fs.readFile(uri);
      const text = dec(content);

      // Fingerprint de-dupe
      const fingerprint = hashString(text);
      const key = normalizePath(uri.fsPath);
      const previous = this.fingerprints.get(key);
      if (previous === fingerprint) {
        // Already imported this content — count as processed, not success.
        return { processed: 1, success: 0, failed: 0 };
      }
      this.fingerprints.set(key, fingerprint);

      try { this.parseService.invalidate(uri.fsPath); } catch {}

      // Try LSP parse first
      try {
        const artifacts = await this.parseService.parseFile(uri, text);
        const ok = await panel.webview.postMessage({ type: 'addArtifacts', payload: artifacts });
        if (!ok) throw new Error('Webview rejected message');
        this.onArtifacts(artifacts);
        return { processed: 1, success: 1, failed: 0 };
      } catch (lspErr: any) {
        // UX fallback: still load a module card (no symbols/edges).
        const fileLabel = vscode.workspace.asRelativePath(uri, false);
        const artifacts: GraphArtifacts = {
          nodes: [{
            id: `mod_${hashString(normalizePath(fileLabel))}`,
            kind: 'module',
            label: fileLabel,
            fsPath: uri.fsPath,
            source: text
          }],
          edges: []
        };
        const ok = await panel.webview.postMessage({ type: 'addArtifacts', payload: artifacts });
        if (ok) {
          this.onArtifacts(artifacts);
          if (!ImportService.lspWarnedThisSession) {
            ImportService.lspWarnedThisSession = true;
            vscode.window.showWarningMessage(
              'DepViz: Language server data missing for some files. Showing module cards only.',
              'Open Extensions'
            ).then(p => { if (p === 'Open Extensions') vscode.commands.executeCommand('workbench.view.extensions'); });
          }
          return { processed: 1, success: 1, failed: 0 };
        }
        // If even posting the fallback failed, count as failed.
        ImportService.out.appendLine(`[importUri] webview rejected module-only payload for ${uri.fsPath}`);
        return { processed: 1, success: 0, failed: 1 };
      }
    } catch (err) {
      const msg = (err as any)?.message ?? String(err);
      ImportService.out.appendLine(`[importUri] ${uri.fsPath}: ${msg}`);
      // One-time LSP guidance (kept from original behavior)
      if (/No language server data available/.test(msg) && !ImportService.lspWarnedThisSession) {
        ImportService.lspWarnedThisSession = true;
        vscode.window.showWarningMessage(
          'DepViz: No language server data for some files. Enable the language extension and try again.',
          'Open Extensions'
        ).then(pick => {
          if (pick === 'Open Extensions') vscode.commands.executeCommand('workbench.view.extensions');
        });
      }
      return { processed: 1, success: 0, failed: 1 };
    }
  }

  resetFingerprints(): void {
    this.fingerprints.clear();
    this.totals.modules = 0;
    this.totals.funcs = 0;
  }

  evictFingerprint(fsPath: string): void {
    this.fingerprints.delete(normalizePath(fsPath));
    try { this.parseService.invalidate(fsPath); } catch {}
  }

  private async findFilesFromRoots(
    roots: vscode.Uri[],
    includeGlobs: string[],
    excludeGlobs: string[],
    maxFiles: number
  ): Promise<vscode.Uri[]> {
    const out: vscode.Uri[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folderSet = new Set(folders.map(f => f.uri.toString()));

    const files = roots.filter(u => !u.path.endsWith('/') && !u.path.endsWith('\\'));
    out.push(...files);

    const dirs = roots.filter(u => !files.includes(u));
    for (const dir of dirs) {
      let baseFolder = folders.find(f => dir.toString().startsWith(f.uri.toString()));
      if (!baseFolder && folderSet.size === 1) {
        baseFolder = folders[0];
      }

      for (const glob of includeGlobs) {
        const includePattern = baseFolder ? new RelativePattern(baseFolder, glob) : glob;
        const excludePattern = excludeGlobs.length ? `{${excludeGlobs.join(',')}}` : undefined;
        const found = await vscode.workspace.findFiles(includePattern as any, excludePattern, Math.max(1, maxFiles - out.length));
        const scoped = baseFolder
          ? found.filter(u => u.fsPath.toLowerCase().startsWith(dir.fsPath.toLowerCase()))
          : found;

        for (const candidate of scoped) {
          if (out.length >= maxFiles) break;
          out.push(candidate);
        }
        if (out.length >= maxFiles) break;
      }
      if (out.length >= maxFiles) break;
    }
    return out;
  }

  private currentMaxFileSize(): number {
    const mb = vscode.workspace.getConfiguration('depviz').get<number>('maxFileSizeMB') ?? 1.5;
    return Math.max(1, mb) * 1_000_000;
  }
}
