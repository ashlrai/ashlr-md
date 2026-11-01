// Type declaration for scripts/ci/validate-dispatch.mjs so TypeScript sources
// (tests under src/) can import it under `tsc --noEmit`.

export const VALID_JOBS: Set<string>;

export interface JobsResult {
  ok: boolean;
  error?: string;
  jobs?: string[];
}

export interface TestsResult {
  ok: boolean;
  error?: string;
  filter?: string;
}

export interface DispatchResult {
  ok: boolean;
  error?: string;
  jobs?: string[];
  filter?: string;
}

export function validateJobs(onlyJobs: string | undefined): JobsResult;
export function validateTests(onlyTests: string | undefined): TestsResult;
export function buildVitestArgs(filter: string): string[];
export function validate(opts?: {
  onlyJobs?: string;
  onlyTests?: string;
  writeLine?: (line: string) => void;
}): DispatchResult;
export function main(): number;
