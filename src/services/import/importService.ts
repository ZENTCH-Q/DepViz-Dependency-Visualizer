// src/services/import/importService.ts
import * as vscode from 'vscode';
import { RelativePattern } from 'vscode';
import { ParseService } from '../parse/parseService';
import { GraphArtifacts, Totals, ParseResult } from '../../shared/types';
import { normalizePath } from '../../shared/workspace';
import { extOf } from '../../shared/text';
import { dec, hash as hashString } from '../../shared/encoding';
import { resolveCrossFileCallsForFile } from '../resolve/crossFileCalls'; // ← NEW

type BatchStats = {
  importedOk: number;
  importedPartial: number;
  importedNoLsp: number;
  failed: number;
  skippedBySize: number;
  skippedByExt: number;
};

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
  public static lspWarnedThisSession = false; // ← public (was private) so helper can read it

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parseService: ParseService,
    private readonly onArtifacts: (artifacts: GraphArtifacts) => void,
    private readonly totals: Totals
  ) {}

  async importMany(uris: vscode.Uri[], panel: vscode.WebviewPanel, hardCap: number): Promise<void> {
    if (!uris.length) return;

    const cfg = vscode.workspace.getConfiguration('depviz');
    const include = (cfg.get<string[]>('includeGlobs') ?? ['**/*']).filter(Boolean);
    const exclude = (cfg.get<string[]>('excludeGlobs') ?? ['**/.git/**', '**/node_modules/**', '**/__pycache__/**']).filter(Boolean);
    const maxFiles = Math.max(1, hardCap | 0);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'DepViz: Importing…', cancellable: true },
      async (progress, token) => {
        const files = await this.findFilesFromRoots(uris, include, exclude, maxFiles);
        const totalFound = files.length;
        const capped = files.slice(0, maxFiles);
        if (totalFound > maxFiles) {
          vscode.window.showInformationMessage(
            `DepViz: Found ${totalFound} files, importing first ${maxFiles}. Adjust "depviz.maxFiles" to change.`
          );
        }

        const stats: BatchStats = {
          importedOk: 0,
          importedPartial: 0,
          importedNoLsp: 0,
          failed: 0,
          skippedBySize: 0,
          skippedByExt: 0
        };

        const batchSize = 8;
        const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

        for (let i = 0; i < capped.length; i += batchSize) {
          if (token.isCancellationRequested) break;
          const slice = capped.slice(i, i + batchSize);
          await Promise.all(slice.map(u => this.importUri(u, panel, token, stats, batchId).catch(() => {})));
          const processed = Math.min(capped.length, i + batchSize);
          progress.report({ message: `${processed}/${capped.length}` });
        }

        // Signal end-of-batch so the webview recomputes inferred edges once
        try {
          await panel.webview.postMessage({
            type: 'addArtifacts',
            payload: { nodes: [], edges: [], batchId, endOfBatch: true }
          });
        } catch {}

        const msg = [
          `Imported OK: ${stats.importedOk}`,
          `Partial: ${stats.importedPartial}`,
          `No LSP: ${stats.importedNoLsp}`,
          `Failed: ${stats.failed}`,
          `Skipped size: ${stats.skippedBySize}`,
          `Skipped type: ${stats.skippedByExt}`
        ].join(' • ');
        vscode.window.showInformationMessage(`DepViz: ${msg}`);
      }
    );
  }

  async importUri(
    uri: vscode.Uri,
    panel: vscode.WebviewPanel,
    token?: vscode.CancellationToken,
    stats?: BatchStats,
    batchId?: string
  ): Promise<void> {
    try {
      if (token?.isCancellationRequested) return;

      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        const children = await vscode.workspace.fs.readDirectory(uri);
        for (const [name] of children) {
          if (SKIP_DIRS.has(name)) continue;
          await this.importUri(vscode.Uri.joinPath(uri, name), panel, token, stats, batchId);
        }
        return;
      }

      if (stat.size && stat.size > this.currentMaxFileSize()) {
        stats && stats.skippedBySize++;
        return;
      }
      if (SKIP_EXTS.has(extOf(uri.path))) {
        stats && stats.skippedByExt++;
        return;
      }

      const content = await vscode.workspace.fs.readFile(uri);
      const text = dec(content);

      const fingerprint = hashString(text);
      const key = normalizePath(uri.fsPath);
      const previous = this.fingerprints.get(key);
      if (previous === fingerprint) return; // unchanged
      this.fingerprints.set(key, fingerprint);

      try { this.parseService.invalidate(uri.fsPath); } catch {}

      let result: ParseResult;
      try {
        result = await this.parseService.parseFile(uri, text);
      } catch (err: any) {
        // parseService already does a nolsp fallback; reaching here = fatal
        stats && (stats.failed++);
        ImportService.out.appendLine(`[importUri] ${uri.fsPath}: ${err?.message ?? String(err)}`);
        maybeWarnLspOnce(err?.message);
        throw err;
      }

      // Always merge something (even nolsp: module-only + imports)
      const artifacts: GraphArtifacts = { nodes: result.nodes, edges: result.edges };
      const payload = batchId ? { ...artifacts, batchId } : artifacts;
      const ok = await panel.webview.postMessage({ type: 'addArtifacts', payload });
      if (!ok) {
        stats && (stats.failed++);
        throw new Error('Webview rejected message');
      }

      // Tally by status
      if (stats) {
        if (result.status === 'ok') stats.importedOk++;
        else if (result.status === 'partial') stats.importedPartial++;
        else stats.importedNoLsp++;
      }
      this.onArtifacts(artifacts);

      // Log diagnostics to output channel, not spammy toasts
      for (const d of (result.diagnostics || [])) {
        ImportService.out.appendLine(`[${d.severity}] ${d.file}: ${d.message}`);
      }

      // --- NEW: cross-file call resolution (Call Hierarchy) ---
      // Opt-in via setting, default true
      const cfg = vscode.workspace.getConfiguration('depviz');
      const enableXfile = cfg.get<boolean>('crossFileCalls', true);
      if (enableXfile && result.status !== 'nolsp') {
        try {
          await resolveCrossFileCallsForFile(uri, this.parseService, panel.webview);
        } catch (e) {
          // Best-effort; ignore failures
          ImportService.out.appendLine(`[xfile] ${uri.fsPath}: ${String((e as Error)?.message || e)}`);
        }
      }
      // --------------------------------------------------------

    } catch (err) {
      // Counted above where possible; ensure we don't double add
      if (stats && !/Webview rejected/.test(String(err))) stats.failed++;
      throw err;
    }
  }

  // NEW: live import from in-memory text (no disk read)
  async importText(
    uri: vscode.Uri,
    text: string,
    panel: vscode.WebviewPanel,
    token?: vscode.CancellationToken,
    stats?: BatchStats,
    batchId?: string
  ): Promise<void> {
    try {
      if (token?.isCancellationRequested) return;

      // Skip obviously huge buffers
      if (text.length > this.currentMaxFileSize()) {
        stats && stats.skippedBySize++;
        return;
      }
      // Honor extension skip list (e.g. images accidentally opened)
      if (SKIP_EXTS.has(extOf(uri.path))) {
        stats && stats.skippedByExt++;
        return;
      }

      const fingerprint = hashString(text);
      const key = normalizePath(uri.fsPath);
      const previous = this.fingerprints.get(key);
      if (previous === fingerprint) return; // unchanged snapshot of text
      this.fingerprints.set(key, fingerprint);

      try { this.parseService.invalidate(uri.fsPath); } catch {}

      let result: ParseResult;
      try {
        // crucial difference: feed in-memory text directly
        result = await this.parseService.parseFile(uri, text);
      } catch (err: any) {
        stats && (stats.failed++);
        ImportService.out.appendLine(`[importText] ${uri.fsPath}: ${err?.message ?? String(err)}`);
        maybeWarnLspOnce(err?.message);
        throw err;
      }

      const artifacts: GraphArtifacts = { nodes: result.nodes, edges: result.edges };
      const payload = batchId ? { ...artifacts, batchId } : artifacts;
      const ok = await panel.webview.postMessage({ type: 'addArtifacts', payload });
      if (!ok) {
        stats && (stats.failed++);
        throw new Error('Webview rejected message');
      }

      // No batch stats increment here by default; live updates are frequent.
      this.onArtifacts(artifacts);

      for (const d of (result.diagnostics || [])) {
        ImportService.out.appendLine(`[${d.severity}] ${d.file}: ${d.message}`);
      }

      // Best-effort cross-file calls on live edits — can be noisy, keep behind setting.
      const cfg = vscode.workspace.getConfiguration('depviz');
      const enableXfile = cfg.get<boolean>('crossFileCalls', true);
      if (enableXfile && result.status !== 'nolsp') {
        try {
          await resolveCrossFileCallsForFile(uri, this.parseService, panel.webview);
        } catch (e) {
          ImportService.out.appendLine(`[xfile-live] ${uri.fsPath}: ${String((e as Error)?.message || e)}`);
        }
      }
    } catch (err) {
      if (stats && !/Webview rejected/.test(String(err))) stats.failed++;
      throw err;
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

function maybeWarnLspOnce(msg?: string) {
  if (!msg) return;
  if (/No language server|timeout/i.test(msg) && !ImportService.lspWarnedThisSession) {
    ImportService.lspWarnedThisSession = true;
    vscode.window.showWarningMessage(
      'DepViz: Language server is missing or slow. Modules will still load; functions/calls may be partial.',
      'Open Extensions'
    ).then(p => { if (p === 'Open Extensions') vscode.commands.executeCommand('workbench.view.extensions'); });
  }
}
