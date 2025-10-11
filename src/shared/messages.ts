// ── Outbound (extension → webview) ────────────────────────────────────────────
export type WebviewOutbound =
  | { type: 'requestSample' }                    // ask the webview to emit its sample (panel only)
  | { type: 'sampleData'; payload: any }         // deliver sample data
  | { type: 'addArtifacts'; payload: any }       // append import graph artifacts
  | { type: 'autoArrange' }                      // trigger layout
  | { type: 'clear' }                            // clear canvas
  | { type: 'loadSnapshot'; payload: any };      // load .dv snapshot

// ── Inbound (webview → extension) ─────────────────────────────────────────────
export type WebviewInbound =
  | { type: 'requestSample' }
  | { type: 'droppedUris'; items: string[] }
  | { type: 'exportData'; kind: 'png' | 'svg' | 'json' | 'dv'; base64: string; suggestedName?: string }
  | { type: 'saveSnapshot'; payload: any }
  | { type: 'evictFingerprint'; fsPath: string }
  | { type: 'openFile'; fsPath: string; view?: 'active' | 'beside' }
  | { type: 'openAt'; fsPath: string; line: number; col: number; view?: 'active' | 'beside' }
  | { type: 'gotoDef'; target: { file: string; name: string }; view?: 'active' | 'beside' }
  | { type: 'peekRefs'; target: { file: string; name: string }; view?: 'active' | 'beside' }
  | { type: 'clearCanvas' }
  | { type: 'edit'; payload: any; label?: string }
  | { type: 'impactSummary'; payload: { dir: 'in' | 'out'; files: string[]; counts: Record<string, number> } };

// Exhaustiveness helper for switch statements
export function assertNever(x: never): never {
  throw new Error(`Unhandled message variant: ${JSON.stringify(x)}`);
}
