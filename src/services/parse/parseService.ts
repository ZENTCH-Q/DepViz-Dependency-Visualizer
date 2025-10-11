// src/services/parse/parseService.ts
import * as vscode from 'vscode';
import { parseFile as doParseFile } from './index';
import { GraphArtifacts } from '../../shared/types';

// path -> parsed graph
export type SymbolIndex = Map<string, GraphArtifacts>;

export class ParseService {
  private index: SymbolIndex = new Map();

  /** Parse one file (LSP-only) and store its graph. */
  public async parseFile(uri: vscode.Uri, text?: string): Promise<GraphArtifacts> {
    const artifacts = await doParseFile(uri, text);
    this.index.set(uri.fsPath, artifacts);
    return artifacts;
    // Note: doParseFile throws if LSP couldn't parse; we don't return null.
  }

  /** Remove a file from the index by fsPath. */
  public invalidate(fsPath: string): void {
    this.index.delete(fsPath);
  }

  /** Snapshot of the index. */
  public getIndex(): SymbolIndex {
    return this.index;
  }

  /** Optional helper to rebuild everything. */
  public async reindexWorkspace(): Promise<void> {
    const uris = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,go,rb,php,rs,java,kt,cs}');
    for (const uri of uris) {
      await this.parseFile(uri);
    }
  }
}
