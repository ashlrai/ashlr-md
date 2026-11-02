// Type declaration for scripts/check-crypto.mjs so TypeScript sources
// (tests under src/) can import it under `tsc --noEmit`.

export const PATTERNS: [string, RegExp][];

export interface CryptoHit {
  file: string;
  kinds: string[];
  allowed: boolean;
  reason: string | undefined;
}

export interface ScanOptions {
  allow?: Record<string, string>;
  dirs?: string[];
  selfNames?: string[];
}

export function scan(root: string, opts?: ScanOptions): CryptoHit[];
export function report(hits: CryptoHit[]): { text: string; failed: boolean };
export function main(root: string, opts?: ScanOptions): number;
