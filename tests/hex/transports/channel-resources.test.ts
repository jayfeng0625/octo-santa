import { describe, it, expect, afterEach } from "bun:test";
import { ResourceNotFoundError } from "@modelcontextprotocol/server";
import { cleanupDb, testDbPath, setupTestDb } from "../../helpers/db";
import { allMigrations } from "../../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { MessagingService } from "../../../src/core/messaging/service";
import {
  channelResourceUri,
  registerChannelResources,
  createConnectionNotificationPort,
} from "../../../src/transports/mcp-stdio/adapter";

const TEST_DB = testDbPath("channel-resources");

afterEach(() => {
  cleanupDb(TEST_DB);
});

function setupMessaging() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
  return { db, svc };
}

// Captures registerResource calls the way tool-metadata tests capture
// registerTool — the SDK's McpServer is not needed to exercise the callbacks.
function makeMockResourceServer() {
  const registered: Record<
    string,
    { template: any; config: any; readCallback: (uri: URL, variables: any) => Promise<any> }
  > = {};
  const server = {
    registerResource: (name: string, template: any, config: any, readCallback: any) => {
      registered[name] = { template, config, readCallback };
    },
  } as any;
  return { server, registered };
}

describe("channelResourceUri", () => {
  it("mints the canonical URI for a plain channel name", () => {
    expect(channelResourceUri("design.review")).toBe(
      "octo-santa://channels/design.review/messages"
    );
  });

  it("percent-encodes DM commas so the template variable can match", () => {
    expect(channelResourceUri("alice,bob")).toBe(
      "octo-santa://channels/alice%2Cbob/messages"
    );
  });

  it("percent-encodes # so the name cannot start a URI fragment", () => {
    expect(channelResourceUri("a#b,c@d.e-f")).toBe(
      "octo-santa://channels/a%23b%2Cc%40d.e-f/messages"
    );
  });

  it("round-trips through the registered template's own matcher", () => {
    const { db, svc } = setupMessaging();
    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => null);
    const template = registered["channel-messages"]!.template;

    for (const name of ["general", "alice,bob", "a#b,c@d.e-f", "w-1_x.y@z"]) {
      const variables = template.uriTemplate.match(channelResourceUri(name));
      expect(variables, `template match for "${name}"`).not.toBeNull();
      // UriTemplate.match does not decode — the read callback owns decoding.
      expect(decodeURIComponent(variables.channel)).toBe(name);
    }
    db.close();
  });
});

describe("registerChannelResources", () => {
  it("registers one template resource with json mime and pure-read description", () => {
    const { db, svc } = setupMessaging();
    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => null);

    const entry = registered["channel-messages"];
    expect(entry).toBeDefined();
    expect(entry!.template.uriTemplate.toString()).toBe(
      "octo-santa://channels/{channel}/messages"
    );
    expect(entry!.config.mimeType).toBe("application/json");
    expect(entry!.config.description).toMatch(/never advances the unread cursor/i);
    db.close();
  });

  it("list callback enumerates all channels with canonical URIs (DMs included)", async () => {
    const { db, svc } = setupMessaging();
    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "general");
    svc.directMessage("alice", "bob", "hi");

    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => null);

    const result = await registered["channel-messages"]!.template.listCallback();
    const byName = Object.fromEntries(result.resources.map((r: any) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(["alice,bob", "general"]);
    expect(byName["general"].uri).toBe("octo-santa://channels/general/messages");
    expect(byName["alice,bob"].uri).toBe("octo-santa://channels/alice%2Cbob/messages");
    expect(byName["general"].mimeType).toBe("application/json");
    db.close();
  });

  it("read returns the newest messages as JSON without touching the unread cursor", async () => {
    const { db, svc } = setupMessaging();
    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "general");
    svc.subscribe("bob", "general");
    svc.send("alice", "general", "for the record");

    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => "bob");

    const uri = new URL(channelResourceUri("general"));
    const result = await registered["channel-messages"]!.readCallback(uri, {
      channel: "general",
    });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe(channelResourceUri("general"));
    expect(result.contents[0].mimeType).toBe("application/json");
    const messages = JSON.parse(result.contents[0].text);
    expect(messages.map((m: any) => m.content)).toEqual(["for the record"]);

    // Purity: the tool read still sees the message as unread afterwards.
    expect(svc.read("bob", "general").map((m) => m.content)).toEqual(["for the record"]);
    db.close();
  });

  it("read decodes percent-encoded channel names from the raw template variable", async () => {
    const { db, svc } = setupMessaging();
    svc.register("alice");
    svc.register("bob");
    svc.directMessage("alice", "bob", "dm history");

    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => "alice");

    const uri = new URL(channelResourceUri("alice,bob"));
    const result = await registered["channel-messages"]!.readCallback(uri, {
      channel: "alice%2Cbob",
    });
    const messages = JSON.parse(result.contents[0].text);
    expect(messages.map((m: any) => m.content)).toEqual(["dm history"]);
    db.close();
  });

  it("read without a bound agent is denied with a register hint", async () => {
    const { db, svc } = setupMessaging();
    svc.register("alice");
    svc.createChannel("alice", "general");

    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => null);

    const uri = new URL(channelResourceUri("general"));
    await expect(
      registered["channel-messages"]!.readCallback(uri, { channel: "general" })
    ).rejects.toThrow(/messaging_register/);
    db.close();
  });

  it("read of an unknown channel maps to the spec resource-not-found error", async () => {
    const { db, svc } = setupMessaging();
    svc.register("alice");

    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => "alice");

    const uri = new URL(channelResourceUri("nope"));
    const err = await registered["channel-messages"]!
      .readCallback(uri, { channel: "nope" })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(ResourceNotFoundError);
    expect((err as ResourceNotFoundError).uri).toBe(channelResourceUri("nope"));
    db.close();
  });

  it("read with malformed percent-encoding maps to resource-not-found, not internal error", async () => {
    const { db, svc } = setupMessaging();
    svc.register("alice");

    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => "alice");

    const uri = new URL("octo-santa://channels/%zz/messages");
    const err = await registered["channel-messages"]!
      .readCallback(uri, { channel: "%zz" })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(ResourceNotFoundError);
    db.close();
  });

  it("read enforces DM privacy for non-members", async () => {
    const { db, svc } = setupMessaging();
    svc.register("alice");
    svc.register("bob");
    svc.register("carol");
    svc.directMessage("alice", "bob", "secret");

    const { server, registered } = makeMockResourceServer();
    registerChannelResources(server, svc, () => "carol");

    const uri = new URL(channelResourceUri("alice,bob"));
    await expect(
      registered["channel-messages"]!.readCallback(uri, { channel: "alice%2Cbob" })
    ).rejects.toThrow(/private to alice and bob/);
    db.close();
  });
});

describe("createConnectionNotificationPort", () => {
  function makeMockMcpServer() {
    const notifications: any[] = [];
    const updated: any[] = [];
    let listChangedCount = 0;
    const mcpServer = {
      sendResourceListChanged: () => {
        listChangedCount++;
      },
      server: {
        notification: async (n: any) => {
          notifications.push(n);
        },
        sendResourceUpdated: async (params: any) => {
          updated.push(params);
        },
      },
    } as any;
    return {
      mcpServer,
      notifications,
      updated,
      listChangedCount: () => listChangedCount,
    };
  }

  it("notify sends the custom channel notification on both eras", async () => {
    for (const era of ["legacy", "modern"] as const) {
      const { mcpServer, notifications } = makeMockMcpServer();
      const port = createConnectionNotificationPort(mcpServer, era);
      await port.notify("hello", {
        channel_name: "general",
        sender: "bob",
        message_id: "1",
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].method).toBe("notifications/claude/channel");
      expect(notifications[0].params.content).toBe("hello");
    }
  });

  it("modern era emits resources/updated with the canonical URI", async () => {
    const { mcpServer, updated } = makeMockMcpServer();
    const port = createConnectionNotificationPort(mcpServer, "modern");
    await port.notifyChannelActivity!("alice,bob");
    expect(updated).toEqual([{ uri: channelResourceUri("alice,bob") }]);
  });

  it("legacy era emits nothing — spec change notifications would pass through unsolicited", async () => {
    const { mcpServer, updated, listChangedCount } = makeMockMcpServer();
    const port = createConnectionNotificationPort(mcpServer, "legacy");
    await port.notifyChannelActivity!("general");
    expect(updated).toEqual([]);
    expect(listChangedCount()).toBe(0);
  });

  it("first activity on an unseen channel also emits list_changed, once per channel", async () => {
    const { mcpServer, updated, listChangedCount } = makeMockMcpServer();
    const port = createConnectionNotificationPort(mcpServer, "modern");

    await port.notifyChannelActivity!("general");
    expect(listChangedCount()).toBe(1);

    await port.notifyChannelActivity!("general");
    expect(listChangedCount()).toBe(1); // same channel — no re-fire

    await port.notifyChannelActivity!("other");
    expect(listChangedCount()).toBe(2); // new channel — fires again

    expect(updated).toHaveLength(3); // updated fires every time
  });
});
