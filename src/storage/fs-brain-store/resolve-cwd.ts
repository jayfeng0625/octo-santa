import { existsSync } from "fs";
import { join, dirname } from "path";
import { log } from "../../log";

export function resolveRepoCwd(opts?: {
  cwd?: string;
  envCwd?: string;
}): string {
  const cwd = opts?.cwd ?? process.cwd();
  const envCwd = opts?.envCwd ?? process.env.OCTO_SANTA_CWD;

  if (envCwd) {
    log(`repo cwd: ${envCwd} (from OCTO_SANTA_CWD)`);
    return envCwd;
  }

  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ".octo-santa", "config.json"))) {
      if (dir !== cwd) log(`repo cwd: ${dir} (found .octo-santa/config.json)`);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return cwd;
}
