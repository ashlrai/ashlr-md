// Type declaration for scripts/tool-path.mjs so TypeScript sources (tests
// under src/) can import it under `tsc --noEmit`.
export function toolPath(
  name: string,
  env?: { PATH?: string; PATHEXT?: string },
): string;
