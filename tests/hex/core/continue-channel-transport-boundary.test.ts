// tests/hex/core/continue-channel-transport-boundary.test.ts
//
// Transport-boundary regression guard for `MessagingService.continueChannel()`.
//
// `continueChannel()` is human-only by transport-restriction (see JSDoc on the
// method in src/core/messaging/service.ts). The architectural invariant is
// that no agent-callable transport (MCP, future RPC, future HTTP) is allowed
// to invoke this method. Currently REPL `/continue` is the sole surface;
// future `ocs continue` CLI will be the second.
//
// This test scans `src/transports/` for `.continueChannel(` references and
// fails if any non-REPL transport invokes it. Adding the method to MCP, RPC,
// or any other agent-driven path will fail here.

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const TRANSPORTS_ROOT = join(REPO_ROOT, "src/transports");
const ALLOWED_TRANSPORT_PREFIXES = [
  "src/transports/repl/",
  // Future: "src/transports/cli/" once `ocs continue` ships
];

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, acc);
    } else if (entry.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function findContinueChannelInvocations(): Array<{ file: string; lines: number[] }> {
  const files = walkTsFiles(TRANSPORTS_ROOT);
  const results: Array<{ file: string; lines: number[] }> = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const matchedLines: number[] = [];
    lines.forEach((line, idx) => {
      if (/\.continueChannel\s*\(/.test(line)) {
        matchedLines.push(idx + 1);
      }
    });
    if (matchedLines.length > 0) {
      results.push({ file: relative(REPO_ROOT, file), lines: matchedLines });
    }
  }
  return results;
}

describe("continueChannel — transport-boundary discipline", () => {
  it("is invoked only from REPL transport files", () => {
    const invocations = findContinueChannelInvocations();
    const violators = invocations.filter(
      (inv) => !ALLOWED_TRANSPORT_PREFIXES.some((prefix) => inv.file.startsWith(prefix))
    );
    expect(violators).toEqual([]);
  });

  it("at least one transport actually calls continueChannel (sanity)", () => {
    const invocations = findContinueChannelInvocations();
    expect(invocations.length).toBeGreaterThan(0);
  });
});
