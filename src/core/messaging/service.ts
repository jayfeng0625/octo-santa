import type {
  AgentRepository,
  ChannelRepository,
  MessageRepository,
  CursorRepository,
  NotificationDispatch,
} from "../ports";
import type {
  Agent,
  Channel,
  Message,
  ReadOptions,
  UnreadResult,
} from "./types";
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
    private readonly dispatch?: NotificationDispatch
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

    const memberIds = new Set(this.channels.getMembers(channelId).map((m) => m.id));
    const targetAgents = mentions.filter(
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
    const memberIds = new Set(this.channels.getMembers(channelId).map((m) => m.id));
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

  register(agentId: string): Agent {
    validateAgentName(agentId);
    return this.agents.register(agentId, this.pid);
  }

  unregister(agentId: string): void {
    this.agents.clearPid(agentId, this.pid);
  }

  createChannel(agentId: string, name: string): Channel {
    if (!name.trim()) throw new Error("channel name must not be empty");
    this.requireRegistered(agentId);
    const channel = this.channels.create(name, agentId);
    this.channels.addMember(agentId, channel.id, 0);
    return channel;
  }

  subscribe(agentId: string, channelName: string): void {
    this.requireRegistered(agentId);
    assertDmAccess(channelName, agentId);
    const channel = this.channels.findByName(channelName);
    if (!channel) throw new Error(`Channel "${channelName}" does not exist`);
    this.channels.addMember(agentId, channel.id, 0);
  }

  send(agentId: string, channelName: string, content: string): Message {
    if (!content.trim()) throw new Error("message content must not be empty");
    this.requireRegistered(agentId);
    assertDmAccess(channelName, agentId);
    const channel = this.channels.findByName(channelName);
    if (!channel) {
      throw new Error(
        `Channel "${channelName}" does not exist. Create it with messaging_create_channel first.`
      );
    }
    const validIds = this.agents.listAll().map((a) => a.id);
    const mentions = extractMentions(content, validIds);
    if (mentions.includes(agentId)) throw new Error("Cannot @mention yourself in a message");

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
        `Not a member of channel "${channelName}". Join via messaging_subscribe or messaging_send.`
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

  // NOT atomic by design: channel creation, membership, and insert are separate
  // repo calls with no enclosing transaction. A failure partway through is
  // recoverable — create and addMember are idempotent (ON CONFLICT DO NOTHING),
  // so the agent simply retries the DM.
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

    const validIds = this.agents.listAll().map((a) => a.id);
    const mentions = extractMentions(content, validIds);
    if (mentions.includes(agentId)) throw new Error("Cannot @mention yourself in a message");

    const message = this.messages.insertAndJoinSender(
      channel.id,
      agentId,
      content,
      mentions
    );

    this.dispatchTo(channelName, agentId, content, message.id, true, [targetAgentId]);

    return message;
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
}
