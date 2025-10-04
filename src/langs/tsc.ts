// src/langs/tsc.ts
// TypeScript Compiler API helpers: type-checked import + call resolution.

import ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { GraphEdge, GraphNode } from '../core/types';
import { toPosix } from '../core/paths';
import { findFuncInFile } from '../core/symbolIndex';

type ProgramBundle = { program: ts.Program; checker: ts.TypeChecker; configDir: string; configPath: string; configMtimeMs: number };

function loadTsConfig(workspaceRoot: string) {
  const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return null;
  const stat = fs.existsSync(configPath) ? fs.statSync(configPath) : null;
  const configText = ts.sys.readFile(configPath) || '';
  const result = ts.parseConfigFileTextToJson(configPath, configText);
  if (result.error) return null;
  const config = ts.parseJsonConfigFileContent(
    result.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
  return { config, configDir: path.dirname(configPath), configPath, configMtimeMs: stat ? stat.mtimeMs : 0 };
}

let CACHED: ProgramBundle | null = null;

function needsRebuild(root: string): boolean {
  if (!CACHED) return true;
  const fresh = loadTsConfig(root);
  if (!fresh) return true;
  return (
    CACHED.configPath !== fresh.configPath ||
    CACHED.configDir !== fresh.configDir ||
    CACHED.configMtimeMs !== fresh.configMtimeMs
  );
}

export function invalidateProgram() { CACHED = null; }

export function getProgram(workspaceRoot: string): ProgramBundle | null {
  try {
    if (!needsRebuild(workspaceRoot)) return CACHED;
    const cfg = loadTsConfig(workspaceRoot);
    if (!cfg) { CACHED = null; return null; }
    const host = ts.createCompilerHost(cfg.config.options, /*setParentNodes*/ false);
    const program = ts.createProgram({
      rootNames: cfg.config.fileNames,
      options: cfg.config.options,
      host
    });
    const checker = program.getTypeChecker();
    CACHED = { program, checker, configDir: cfg.configDir, configPath: cfg.configPath, configMtimeMs: cfg.configMtimeMs };
    return CACHED;
  } catch {
    CACHED = null;
    return null;
  }
}

function sourceFor(program: ts.Program, filePath: string): ts.SourceFile | undefined {
  return program.getSourceFile(path.resolve(filePath));
}

export function resolveImportsWithTs(
  fileFsPath: string,
  workspaceRoot: string
): Map<string, string> {
  const out = new Map<string, string>();
  const bundle = getProgram(workspaceRoot);
  if (!bundle) return out;
  const { program } = bundle;

  const sf = sourceFor(program, fileFsPath);
  if (!sf) return out;

  const options = program.getCompilerOptions();
  const host: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath
  };

  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specLit = (node as any).moduleSpecifier as ts.StringLiteral | undefined;
      if (!specLit) return;
      const spec = specLit.text;
      const resolved = ts.resolveModuleName(spec, sf.fileName, options, host).resolvedModule;
      if (resolved?.resolvedFileName) out.set(spec, toPosix(path.resolve(resolved.resolvedFileName)));
    } else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach((decl) => {
        const init = decl.initializer;
        if (!init) return;
        if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'require' &&
          init.arguments.length === 1 &&
          ts.isStringLiteral(init.arguments[0]!)
        ) {
          const spec = (init.arguments[0] as ts.StringLiteral).text;
          const resolved = ts.resolveModuleName(spec, sf.fileName, options, host).resolvedModule;
          if (resolved?.resolvedFileName) out.set(spec, toPosix(path.resolve(resolved.resolvedFileName)));
        }
      });
    }
  });

  return out;
}

function nodeLine(sf: ts.SourceFile, pos: number) {
  const { line } = sf.getLineAndCharacterOfPosition(pos);
  return line | 0;
}

type FnSpan = { id: string; start: number; end: number };
function buildFnSpans(sf: ts.SourceFile, nodes: GraphNode[]): FnSpan[] {
  const mine = nodes.filter((n) => n.kind === 'func' && n.fsPath && toPosix(n.fsPath) === toPosix(sf.fileName));
  const sorted = mine.sort((a, b) => (a.range!.line - b.range!.line));
  const spans: FnSpan[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const start = a.range?.line ?? 0;
    const end = (b?.range?.line ?? nodeLine(sf, sf.end)) - 1;
    spans.push({ id: a.id, start, end });
  }
  return spans;
}
function ownerFnId(line: number, spans: FnSpan[]): string | null {
  for (const sp of spans) if (line >= sp.start && line <= sp.end) return sp.id;
  return null;
}

export function resolveCallsWithTs(
  fileFsPath: string,
  nodes: GraphNode[],
  workspaceRoot: string
): Pick<GraphEdge, 'from' | 'to' | 'type' | 'confidence'>[] {
  const edges: Pick<GraphEdge, 'from' | 'to' | 'type' | 'confidence'>[] = [];
  const bundle = getProgram(workspaceRoot);
  if (!bundle) return edges;
  const { program, checker } = bundle;
  const sf = sourceFor(program, fileFsPath);
  if (!sf) return edges;

  const spans = buildFnSpans(sf, nodes);

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (!ts.isIdentifier(n.expression)) { ts.forEachChild(n, visit); return; }
      const calleeId = n.expression;
      const sym = checker.getSymbolAtLocation(calleeId);
      if (!sym) { ts.forEachChild(n, visit); return; }

      const decl = (sym.declarations || []).find((d) =>
        ts.isFunctionDeclaration(d) ||
        ts.isMethodDeclaration(d) ||
        ts.isFunctionExpression(d) ||
        ts.isArrowFunction(d)
      );
      if (!decl) { ts.forEachChild(n, visit); return; }

      const targetFile = decl.getSourceFile().fileName;
      let bare = calleeId.text;
      if ((decl as any).name && ts.isIdentifier((decl as any).name)) {
        bare = ((decl as any).name as ts.Identifier).text || bare;
      }

      const ent = findFuncInFile(bare, toPosix(targetFile));
      if (ent) {
        const line = nodeLine(sf, n.getStart(sf));
        const callerId = ownerFnId(line, spans);
        if (callerId && callerId !== ent.id) {
          edges.push({ from: callerId, to: ent.id, type: 'call', confidence: 'ts' });
        }
      }
      ts.forEachChild(n, visit);
      return;
    }
    ts.forEachChild(n, visit);
  };

  visit(sf);
  return edges;
}
