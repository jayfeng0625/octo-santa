import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export function createTmpDirTracker(prefix: string) {
  const dirs: string[] = [];

  return {
    make(): string {
      const dir = mkdtempSync(join(tmpdir(), `octo-santa-test-${prefix}-`));
      dirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of dirs) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
      dirs.length = 0;
    },
  };
}
