// src/services/parse/index.ts
import * as vscode from 'vscode';
import { parseWithLsp } from './lspParser';
import { GraphArtifacts } from '../../shared/types';

export async function parseFile(uri: vscode.Uri, text?: string): Promise<GraphArtifacts> {
  const src = text ?? (await vscode.workspace.openTextDocument(uri)).getText();
  let lsp = await parseWithLsp(uri, src);
  if (!lsp) {
    await new Promise(r => setTimeout(r, 150));
    lsp = await parseWithLsp(uri, src);
  }
  if (!lsp) {
    // LSP-only mode: be explicit so callers can handle/report it.
    throw new Error(
      'No language server data available for this file. ' +
      'Make sure the appropriate VS Code language extension is enabled/running.'
    );
  }
  return lsp;
}
