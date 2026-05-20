// tests/hex/transports/no-messaging-continue-tool.test.ts
//
// Regression guard for the messaging_continue MCP tool removal (commit dd777fa).
//
// `messaging_continue` was originally an MCP tool with a "human-only"
// description. That was description-as-enforcement — agents could ignore the
// text and call the tool. The architectural fix was to remove it from the MCP
// surface entirely; the REPL `/continue` command (and future `ocs continue`
// CLI subcommand) is the only human-callable surface.
//
// This file pins the registered MCP tool list. Adding `messaging_continue`
// back to the registry — or any new agent-callable hop-bypass tool — fails
// loudly here. Any other change to the tool surface also fails this test,
// forcing a deliberate update with reviewer awareness.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ADAPTER_PATH = join(
  import.meta.dir,
  "../../../src/transports/mcp-stdio/adapter.ts"
);

const EXPECTED_MCP_TOOLS = [
  "brain_claim_domain",
  "brain_find_expert",
  "brain_index",
  "brain_read",
  "brain_shared_index",
  "brain_shared_read",
  "messaging_create_channel",
  "messaging_direct_message",
  "messaging_get_instructions",
  "messaging_list_agents",
  "messaging_list_channels",
  "messaging_list_members",
  "messaging_listen",
  "messaging_read_messages",
  "messaging_register",
  "messaging_rename_channel",
  "messaging_send_message",
  "messaging_subscribe",
];

function extractRegisteredToolNames(): string[] {
  const source = readFileSync(ADAPTER_PATH, "utf-8");
  const re = /server\.registerTool\("([^"]+)"/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    names.push(match[1]!);
  }
  return names.sort();
}

describe("MCP tool registry — pinned surface", () => {
  it("registered tool names match the expected list exactly", () => {
    const actual = extractRegisteredToolNames();
    expect(actual).toEqual(EXPECTED_MCP_TOOLS);
  });

  it("messaging_continue is NOT registered as an MCP tool (transport-boundary invariant)", () => {
    const actual = extractRegisteredToolNames();
    expect(actual).not.toContain("messaging_continue");
  });

  it("no other agent-callable hop-bypass tool snuck in", () => {
    const actual = extractRegisteredToolNames();
    const suspicious = actual.filter((name) =>
      /continue|reset.*hop|bump.*hop|hop.*reset|hop.*bump|allowance|bypass/i.test(name)
    );
    expect(suspicious).toEqual([]);
  });
});
