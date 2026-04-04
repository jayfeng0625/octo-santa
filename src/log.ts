import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PATH = join(homedir(), ".octo-santa", "server.log");

export function log(msg: string) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // Best-effort logging — don't crash if home dir is read-only
  }
}
