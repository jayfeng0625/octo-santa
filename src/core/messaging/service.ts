import type {
  AgentRepository,
  ChannelRepository,
  MessageRepository,
  CursorRepository,
  NotificationDispatch,
  ProfileRepository,
} from "../ports";
import type {
  Agent,
  Channel,
  Message,
  ReadOptions,
  UnreadResult,
  SendOptions,
  ContinueResult,
} from "./types";
import type { RegisterResult, AutoJoinResult, ProfileFields } from "../profiles/types";
import {
  validateAgentName,
  assertDmAccess,
  isDmChannel,
  dmChannelName,
  parseDmChannelName,
  extractMentions,
  isAgentActive,
} from "../utils";

export class MessagingService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly channels: ChannelRepository,
    private readonly messages: MessageRepository,
    private readonly cursors: CursorRepository,
    private readonly pid: number,
    private readonly dispatch?: NotificationDispatch,
    private readonly profiles?: ProfileRepository
  ) {}

  private requireRegistered(agentId: string): void {
    validateAgentName(agentId);
    const agent = this.agents.findById(agentId);
    if (!agent || agent.pid !== this.pid) {
      throw new Error(
        `Agent "${agentId}" must call messaging_register before using messaging tools`
      );
    }
  }

  private otherMembers(channelId: number, exclude: string): string[] {
    return this.channels
      .getMembers(channelId)
      .map((m) => m.id)
      .filter((id) => id !== exclude);
  }

  private resolveTargets(
    channelId: number,
    channelName: string,
    mentions: string[],
    senderId: string
  ): { targetAgents: string[]; isDm: boolean } {
    const isDm = this.isDmChannelWithMembers(channelName, channelId);

    if (isDm) {
      return { targetAgents: this.otherMembers(channelId, senderId), isDm: true };
    }

    if (mentions.length === 0) {
      return { targetAgents: [], isDm: false };
    }

    if (mentions.includes("*")) {
      return { targetAgents: this.otherMembers(channelId, senderId), isDm: false };
    }

    const members = this.channels.getMembers(channelId);
    const memberIds = new Set(members.map((m) => m.id));
    const baseNames = this.profiles?.getBaseNames();

    const expandedTargets = new Set<string>();
    for (const mention of mentions) {
      if (baseNames?.has(mention)) {
        // Expand base-name mention to live instances
        const instances = this.agents.findByBaseName(mention);
        for (const inst of instances) {
          if (isAgentActive(inst)) {
            expandedTargets.add(inst.id);
          }
        }
      } else {
        expandedTargets.add(mention);
      }
    }

    const targetAgents = [...expandedTargets].filter(
      (id) => id !== senderId && memberIds.has(id)
    );
    return { targetAgents, isDm: false };
  }

  private isDmChannelWithMembers(
    channelName: string,
    channelId: number
  ): boolean {
    const p = parseDmChannelName(channelName);
    if (!p) return false;
    const members = this.channels.getMembers(channelId);
    const memberIds = new Set(members.map((m) => m.id));
    return memberIds.has(p.lo) && memberIds.has(p.hi);
  }

  private dispatchTo(
    channelName: string,
    sender: string,
    content: string,
    messageId: number,
    isDm: boolean,
    targetAgents: string[]
  ): void {
    if (!this.dispatch) return;
    if (targetAgents.length === 0) return;
    this.dispatch.dispatch({
      channelName,
      sender,
      content,
      messageId,
      isDm,
      targetAgents,
    });
  }

  register(agentId: string): RegisterResult {
    validateAgentName(agentId);

    // (1) Exact profile match → delegate to agents.registerWithProfile()
    const profile = this.profiles?.getProfile(agentId) ?? null;
    if (profile) {
      const { agent, registeredName, instanceNumber } = this.agents.registerWithProfile(
        profile.name,
        this.pid,
        profile.maxInstances,
        { persona: profile.persona, objective: profile.objective, instructions: profile.instructions }
      );
      const autoJoined = this.performAutoJoin(registeredName, profile.autoJoinChannels);
      return {
        ...agent,
        registeredName,
        baseName: profile.name,
        instanceNumber,
        profile: {
          persona: profile.persona,
          objective: profile.objective,
          instructions: profile.instructions,
          maxInstances: profile.maxInstances,
        },
        autoJoined,
      };
    }

    // (2) Suffixed namespace reservation: name matches {base}-\d+ for existing profile → reject
    if (this.profiles) {
      const match = /^(.+)-(\d+)$/.exec(agentId);
      if (match) {
        const baseName = match[1]!;
        const existingProfile = this.profiles.getProfile(baseName);
        if (existingProfile) {
          throw new Error(
            `Name "${agentId}" is reserved by pool profile "${baseName}". Register as "${baseName}" to join the pool.`
          );
        }
      }
    }

    // (3) No match → current behavior
    const agent = this.agents.register(agentId, this.pid);
    return {
      ...agent,
      registeredName: agentId,
      baseName: null,
      instanceNumber: null,
      profile: null,
      autoJoined: null,
    };
  }

  private performAutoJoin(agentId: string, channels: string[]): AutoJoinResult {
    const succeeded: string[] = [];
    const failed: Array<{ channel: string; reason: string }> = [];
    for (const channelName of channels) {
      try {
        this.subscribe(agentId, channelName);
        succeeded.push(channelName);
      } catch (err) {
        failed.push({ channel: channelName, reason: String(err) });
      }
    }
    return { succeeded, failed };
  }

  unregister(agentId: string): void {
    this.agents.clearPid(agentId, this.pid);
  }

  createChannel(agentId: string, name: string, maxHops?: number): Channel {
    if (!name.trim()) throw new Error("channel name must not be empty");
    if (maxHops !== undefined && maxHops < 1) {
      throw new Error("maxHops must be at least 1");
    }
    this.requireRegistered(agentId);
    return this.channels.create(name, agentId, maxHops);
  }

  subscribe(agentId: string, channelName: string): void {
    this.requireRegistered(agentId);
    assertDmAccess(channelName, agentId);
    const channel = this.channels.findByName(channelName);
    if (!channel) throw new Error(`Channel "${channelName}" does not exist`);
    this.channels.addMember(agentId, channel.id, 0);
  }

  /**
   * I2 — Gap#2: stop-only unsubscribe (spec §2.4). Stops membership + delivery but PRESERVES
   * the read position so a later re-subscribe resumes from the held cursor (not full backlog).
   */
  unsubscribe(agentId: string, channelName: string): void {
    this.requireRegistered(agentId);
    assertDmAccess(channelName, agentId);
    const channel = this.channels.findByName(channelName);
    if (!channel) throw new Error(`Channel "${channelName}" does not exist`);
    this.channels.unsubscribeMember(agentId, channel.id);
  }

  send(agentId: string, channelName: string, content: string, options?: SendOptions): Message {
    if (!content.trim()) throw new Error("message content must not be empty");
    this.requireRegistered(agentId);
    assertDmAccess(channelName, agentId);
    const channel = this.channels.findByName(channelName);
    if (!channel) {
      throw new Error(
        `Channel "${channelName}" does not exist. Create it with messaging_create_channel first.`
      );
    }
    const allAgents = this.agents.listAll();
    const validIds = allAgents.map((a) => a.id);
    const mentions = extractMentions(content, validIds, this.profiles?.getBaseNames());
    if (mentions.includes(agentId)) throw new Error("Cannot @mention yourself in a message");

    // Hop counter logic
    if (options?.human) {
      this.channels.resetHopCount(channel.id);
    } else {
      this.enforceHopLimit(channel, channelName, agentId);
    }

    const message = this.messages.insertAndJoinSender(
      channel.id,
      agentId,
      content,
      mentions
    );

    const { targetAgents, isDm } = this.resolveTargets(
      channel.id,
      channelName,
      mentions,
      agentId
    );
    this.dispatchTo(channelName, agentId, content, message.id, isDm, targetAgents);

    return message;
  }

  read(agentId: string, channelName: string, opts?: ReadOptions): Message[] {
    this.requireRegistered(agentId);
    const channel = this.channels.findByName(channelName);
    if (!channel) {
      throw new Error(
        `Channel "${channelName}" does not exist. Use messaging_create_channel to create it first.`
      );
    }
    const members = this.channels.getMembers(channel.id);
    if (!members.find((m) => m.id === agentId)) {
      throw new Error(
        `Not a member of channel "${channelName}". Join via messaging_subscribe, messaging_send_message, or messaging_direct_message.`
      );
    }
    if (opts?.before_id !== undefined) {
      return this.messages.readBefore(
        channel.id,
        opts.before_id,
        opts.limit ?? 50,
        agentId
      );
    }
    return this.messages.readForwardAndAdvance(
      agentId,
      channel.id,
      opts?.limit ?? 100
    );
  }

  readAllUnread(agentId: string): UnreadResult[] {
    this.requireRegistered(agentId);
    const cursorList = this.cursors.listForAgent(agentId);
    const results: UnreadResult[] = [];
    for (const cursor of cursorList) {
      const messages = this.messages.readForwardAndAdvance(agentId, cursor.channelId, 100);
      if (messages.length === 0) continue;
      results.push({
        channel: cursor.channelName,
        messages,
        is_dm: isDmChannel(cursor.channelName),
      });
    }
    return results;
  }

  /**
   * NOT atomic by design (accepted deviation). The DM flow is several
   * independent repo calls — createChannel, addMember x2, checkAndIncrementHop,
   * insertAndJoinSender — with NO enclosing transaction. A failure partway
   * through (channel created, message unsent) is recoverable: the agent retries
   * directMessage, which is idempotent on channel creation (channels.create uses
   * ON CONFLICT(name) DO NOTHING) and membership (addMember uses
   * ON CONFLICT(agent_id,channel_id) DO NOTHING), and re-sends. We accept the
   * partial-state window over a single wrapping transaction because it is
   * harmless and recoverable.
   */
  directMessage(
    agentId: string,
    targetAgentId: string,
    content: string
  ): Message {
    validateAgentName(targetAgentId);
    if (agentId === targetAgentId) throw new Error("Cannot DM yourself");
    if (!content.trim()) throw new Error("message content must not be empty");

    const target = this.agents.findById(targetAgentId);
    if (!target) throw new Error(`Agent "${targetAgentId}" not found`);

    const channelName = dmChannelName(agentId, targetAgentId);

    const channel = this.createChannel(agentId, channelName);

    this.channels.addMember(agentId, channel.id, 0);
    this.channels.addMember(targetAgentId, channel.id, 0);

    const allAgents = this.agents.listAll();
    const validIds = allAgents.map((a) => a.id);
    const mentions = extractMentions(content, validIds, this.profiles?.getBaseNames());
    if (mentions.includes(agentId)) throw new Error("Cannot @mention yourself in a message");

    // Hop counter logic for DMs (always agent, no human option)
    this.enforceHopLimit(channel, channelName, agentId);

    const message = this.messages.insertAndJoinSender(
      channel.id,
      agentId,
      content,
      mentions
    );

    this.dispatchTo(channelName, agentId, content, message.id, true, [targetAgentId]);

    return message;
  }

  /**
   * Best-effort dedup for hop-limit `_system` notices.
   *
   * **Race window accepted by design.** This read sits OUTSIDE the
   * checkAndIncrementHop transaction, so under concurrent multi-agent load
   * (N processes hitting the limit simultaneously) up to N duplicate notices
   * may be emitted. That is the intended trade-off:
   *
   *   (a) The dedup-inside-txn alternative would serialize the increment hot
   *       path. Hop checks happen on every send; serializing them under load
   *       is a correctness win for dedup but a throughput cliff for messaging.
   *   (b) Downstream consumers (REPL display, future Slack mirror, audit log)
   *       must already tolerate duplicate messages from at-least-once delivery
   *       semantics — duplicate hop notices are a strict subset of that
   *       tolerance requirement.
   *   (c) Noise is bounded: max(duplicates) === count(concurrent listening
   *       processes hitting the limit at the same instant). Once the limit is
   *       hit, subsequent sends are blocked and stop emitting notices, so the
   *       fan-out self-resolves within one increment cycle.
   *
   * If the empirical fan-out is ever observed > ~3 duplicates in production,
   * revisit by either (i) moving dedup into the increment transaction, or
   * (ii) adding an INSERT … WHERE NOT EXISTS guard at the storage layer.
   */
  private enforceHopLimit(channel: Channel, channelName: string, agentId: string): void {
    const hop = this.channels.checkAndIncrementHop(channel.id);
    if (!hop.allowed) {
      if (!this.hasRecentHopNotice(channel.id)) {
        this.sendSystemNotice(
          channel,
          `hop limit reached (${hop.hopCount}/${hop.maxHops}) in #${channelName} -- message from @${agentId} blocked. Waiting for human input.`
        );
      }
      throw new Error(
        `Hop limit reached (${hop.hopCount}/${hop.maxHops}) in #${channelName}. Message dropped. Only a human can /continue.`
      );
    }
  }

  private hasRecentHopNotice(channelId: number): boolean {
    const recent = this.messages.readRecent(channelId, 1);
    return recent.length > 0
      && recent[0]!.agent_id === '_system'
      && recent[0]!.content.startsWith('hop limit reached');
  }

  private sendSystemNotice(channel: Channel, content: string): void {
    const message = this.messages.insertAndJoinSender(channel.id, '_system', content, ['*']);
    const targetAgents = this.otherMembers(channel.id, '_system');
    this.dispatchTo(channel.name, '_system', content, message.id, isDmChannel(channel.name), targetAgents);
  }

  renameChannel(
    agentId: string,
    channelName: string,
    newName: string
  ): Channel {
    if (!newName.trim()) throw new Error("new channel name must not be empty");
    this.requireRegistered(agentId);
    if (isDmChannel(channelName))
      throw new Error("Cannot rename a DM channel");
    if (isDmChannel(newName))
      throw new Error("Cannot rename a channel to a DM-style name");
    const channel = this.channels.findByName(channelName);
    if (!channel) throw new Error(`Channel "${channelName}" not found`);
    const members = this.channels.getMembers(channel.id);
    if (!members.find((m) => m.id === agentId)) {
      throw new Error(`Not a member of channel "${channelName}"`);
    }
    return this.channels.renameWithAnnouncement(channel.id, newName, agentId);
  }

  listChannels(): Channel[] {
    return this.channels.list();
  }

  listAgents(includeStale?: boolean): Agent[] {
    const agents = this.agents.listAll();
    if (includeStale) return agents;
    return agents.filter(isAgentActive);
  }

  listMembers(
    channelName: string
  ): Array<{ agent_id: string; active: boolean }> {
    const channel = this.channels.findByName(channelName);
    if (!channel) return [];
    const members = this.channels.getMembers(channel.id);
    return members.map((agent) => ({
      agent_id: agent.id,
      active: isAgentActive(agent),
    }));
  }

  getInstructions(agentId: string): {
    profile: ProfileFields | null;
  } {
    this.requireRegistered(agentId);
    const agent = this.agents.findById(agentId);
    if (!agent) return { profile: null };

    // Read from persisted DB data, not live YAML — instructions are
    // snapshotted at registration time and should not change mid-session.
    if (!agent.base_name) {
      return { profile: null };
    }

    return {
      profile: {
        persona: agent.persona,
        objective: agent.objective,
        instructions: agent.instructions,
      },
    };
  }

  /**
   * Bump a channel's hop allowance to resume after a hop-limit block.
   *
   * **Human-only / transport-restricted.** This method MUST only be invoked
   * from a transport that enforces the human-source invariant by construction.
   * The REPL `/continue` command is the canonical surface; the future `ocs
   * continue` CLI subcommand will be the second.
   *
   * Do NOT expose this method via any MCP tool, RPC endpoint, HTTP handler, or
   * other agent-callable interface. Agents bypassing this restriction would
   * defeat the safety-rails design — they could indefinitely extend their own
   * hop budget. The original `messaging_continue` MCP tool was removed for
   * exactly this reason; see `tests/hex/transports/no-messaging-continue-tool.test.ts`
   * and `tests/hex/core/continue-channel-transport-boundary.test.ts` for the
   * regression guards.
   *
   * Enforcement is by transport boundary, not by code-level role check. Adding
   * a check here is impractical — the core has no concept of "human" beyond the
   * `SendOptions.human` flag, which is itself transport-set. The contract is:
   * if you wire a new transport, you are responsible for ensuring this method
   * is invoked only from a human-driven code path.
   */
  continueChannel(agentId: string, channelName: string, amount: number = 4): ContinueResult {
    this.requireRegistered(agentId);
    if (amount < 1) throw new Error("amount must be at least 1");
    const channel = this.channels.findByName(channelName);
    if (!channel) throw new Error(`Channel "${channelName}" not found`);
    const result = this.channels.bumpHopAllowance(channel.id, amount);
    return { channel: channelName, hopCount: result.hopCount, maxHops: result.maxHops, bumped: amount };
  }

  readRecent(channelName: string, limit: number): Message[] {
    const channel = this.channels.findByName(channelName);
    if (!channel) return [];
    return this.messages.readRecent(channel.id, limit);
  }

  /**
   * I3 — Gap#3: stateless forward replay backing the SQLite PubSub adapter's replayFrom.
   * Returns messages strictly after sinceId (FIFO), INCLUDING the caller's own; advances
   * no cursor. NOT a readSince call — readSince self-excludes the named agent.
   *
   * R2 — F3: gated like read() — the single source of truth for "can this agent read this
   * channel": requireRegistered + assertDmAccess + membership. Without it a registered
   * non-member could replay a private DM's full history (a forgeable opaque cursor does not
   * bypass this — the gate is per-channel on the channelName arg). An unknown channel stays a
   * non-creating empty read (the forward-read contract replayFrom depends on), checked before
   * membership since you cannot be a member of a channel that does not exist.
   */
  replayMessages(
    agentId: string,
    channelName: string,
    sinceId: number,
    limit: number
  ): Message[] {
    this.requireRegistered(agentId);
    assertDmAccess(channelName, agentId);
    const channel = this.channels.findByName(channelName);
    if (!channel) return [];
    const members = this.channels.getMembers(channel.id);
    if (!members.find((m) => m.id === agentId)) {
      throw new Error(
        `Not a member of channel "${channelName}". Join via messaging_subscribe, messaging_send_message, or messaging_direct_message.`
      );
    }
    return this.messages.replayMessages(channel.id, sinceId, limit);
  }

  getCursorPosition(agentId: string, channelName: string): number {
    const channel = this.channels.findByName(channelName);
    if (!channel) return 0;
    return this.cursors.get(agentId, channel.id);
  }

  /**
   * I1 — Gap#1: per-ACK cursor advance. Persists the subscriber's read position to
   * exactly the ACKed message id. The SQLite PubSub adapter's pump() calls this once per
   * delivered message (single-step); on NACK it simply does not call it, so the cursor
   * holds and the message is re-read next cycle (head-of-line). No-op for an unknown channel.
   */
  advanceCursor(agentId: string, channelName: string, messageId: number): void {
    const channel = this.channels.findByName(channelName);
    if (!channel) return;
    this.cursors.set(agentId, channel.id, messageId);
  }

  pollNewMessages(
    channelName: string,
    sinceId: number,
    agentId: string,
    limit: number = 50
  ): Message[] {
    const channel = this.channels.findByName(channelName);
    if (!channel) return [];
    return this.messages.readSince(channel.id, sinceId, limit, agentId);
  }
}
