// src/services/parse/parseService.ts
import * as vscode from 'vscode';
import { parseFile as doParseFile } from './index';
import { ParseResult } from '../../shared/types';

// path -> parsed graph (full ParseResult so we keep diagnostics/status)
export type SymbolIndex = Map<string, ParseResult>;

export class ParseService {
  private index: SymbolIndex = new Map();

  /** Parse one file (LSP-first with fallback) and store its graph. */
  public async parseFile(uri: vscode.Uri, text?: string): Promise<ParseResult> {
    const result = await doParseFile(uri, text);
    this.index.set(uri.fsPath, result);
    return result;
    // Note: doParseFile throws only on truly fatal errors (post-fallback).
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
