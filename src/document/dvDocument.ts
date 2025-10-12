// src/document/dvDocument.ts
import * as vscode from 'vscode';
import { enc, dec } from '../shared/encoding';

const EMPTY_SNAPSHOT =
  '{"version":1,"pan":{"x":0,"y":0},"zoom":1,"typeVisibility":{"import":true,"call":true},"data":{"nodes":[],"edges":[]}}';

export class DvDocument implements vscode.CustomDocument {
  static async create(uri: vscode.Uri): Promise<DvDocument> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      bytes = new Uint8Array();
    }
    const text = bytes && bytes.length ? dec(bytes) : EMPTY_SNAPSHOT;
    return new DvDocument(uri, text);
  }

  private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<{ label?: string; undo(): Thenable<void>; redo(): Thenable<void> }>();

  public readonly onDidDispose = this.onDidDisposeEmitter.event;
  public readonly onDidChangeCustomDocument = this.onDidChangeEmitter.event;

  private text: string;
  private savedText: string;

  private constructor(public readonly uri: vscode.Uri, initialText: string) {
    this.text = initialText;
    this.savedText = initialText;
  }

  dispose(): void {
    this.onDidDisposeEmitter.fire();
    this.onDidDisposeEmitter.dispose();
    this.onDidChangeEmitter.dispose();
  }

  getText(): string {
    return this.text;
  }

  applyEdit(nextText: string, label = 'Edit graph'): void {
    const prev = this.text;
    if (prev === nextText) {
      return;
    }
    this.text = nextText;
    this.onDidChangeEmitter.fire({
      label,
      undo: () => {
        this.text = prev;
        return Promise.resolve();
      },
      redo: () => {
        this.text = nextText;
        return Promise.resolve();
      }
    });
  }

  async save(token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) {
      throw new Error('Cancelled');
    }
    await vscode.workspace.fs.writeFile(this.uri, enc(this.text));
    this.savedText = this.text;
  }

  async saveAs(target: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) {
      throw new Error('Cancelled');
    }
    await vscode.workspace.fs.writeFile(target, enc(this.text));
    this.savedText = this.text;
  }

  async revert(token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) {
      throw new Error('Cancelled');
    }
    const bytes = await vscode.workspace.fs.readFile(this.uri);
    const text = dec(bytes);
    const previous = this.text;
    this.text = text;
    this.savedText = text;
    this.onDidChangeEmitter.fire({
      label: 'Revert',
      undo: () => {
        this.text = previous;
        return Promise.resolve();
      },
      redo: () => {
        this.text = text;
        return Promise.resolve();
      }
    });
  }

  async backup(destination: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    if (token.isCancellationRequested) {
      throw new Error('Cancelled');
    }
    await vscode.workspace.fs.writeFile(destination, enc(this.text));
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // best effort
        }
      }
    };
  }
}
