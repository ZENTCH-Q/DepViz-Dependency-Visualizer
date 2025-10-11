// src/services/parse/utils.ts

export function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function makeModuleId(label: string): string {
  return `mod:${normalizePosixPath(label)}`;
}

export function makeClassId(fileLabel: string, className: string): string {
  return `cls:${normalizePosixPath(fileLabel)}#${className}`;
}

export function makeFuncId(fileLabel: string, name: string, line: number): string {
  return `fn:${normalizePosixPath(fileLabel)}#${name}@${line}`;
}
