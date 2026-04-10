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
} from "./types";
import {
  validateAgentName,
  assertDmAccess,
  isDmChannel,
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

  private resolveTargets(
    channelId: number,
    channelName: string,
    mentions: string[],
    senderId: string
  ): { targetAgents: string[]; isDm: boolean } {
    const isDm = this.isDmChannelWithMembers(channelName, channelId);

    if (isDm) {
      const members = this.channels.getMembers(channelId);
      const targetAgents = members
        .map((m) => m.id)
        .filter((id) => id !== senderId);
      return { targetAgents, isDm: true };
    }

    if (mentions.length === 0) {
      return { targetAgents: [], isDm: false };
    }

    if (mentions.includes("*")) {
      const members = this.channels.getMembers(channelId);
      const targetAgents = members
        .map((m) => m.id)
        .filter((id) => id !== senderId);
      return { targetAgents, isDm: false };
    }

    const members = this.channels.getMembers(channelId);
    const memberIds = new Set(members.map((m) => m.id));
    const targetAgents = mentions.filter(
      (id) => id !== senderId && memberIds.has(id)
    );
    return { targetAgents, isDm: false };
  }

  private isDmChannelWithMembers(
    channelName: string,
    channelId: number
  ): boolean {
    if (!isDmChannel(channelName)) return false;
    const match = /^([\w-]+),([\w-]+)$/.exec(channelName);
    if (!match) return false;
    const members = this.channels.getMembers(channelId);
    const memberIds = new Set(members.map((m) => m.id));
    return memberIds.has(match[1]!) && memberIds.has(match[2]!);
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
    return this.channels.create(name, agentId);
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
    const allAgents = this.agents.listAll();
    const validIds = allAgents.map((a) => a.id);
    const mentions = extractMentions(content, validIds);
    const message = this.messages.insertAndJoinSender(
      channel.id,
      agentId,
      content,
      mentions
    );

    if (this.dispatch) {
      const { targetAgents, isDm } = this.resolveTargets(
        channel.id,
        channelName,
        mentions,
        agentId
      );
      if (targetAgents.length > 0) {
        this.dispatch.dispatch({
          channelName,
          sender: agentId,
          content,
          messageId: message.id,
          isDm,
          targetAgents,
        });
      }
    }

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

  /**
   * Accepted deviation (spec section 6.3): current code wraps
   * create+subscribe+send in one .immediate() transaction. The hex
   * architecture uses separate repo calls — failure partway through
   * is recoverable (channel created, message unsent; agent retries).
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

    const sorted = [agentId, targetAgentId].sort();
    const channelName = `${sorted[0]},${sorted[1]}`;

    const channel = this.createChannel(agentId, channelName);

    this.channels.addMember(agentId, channel.id, 0);
    this.channels.addMember(targetAgentId, channel.id, 0);

    const allAgents = this.agents.listAll();
    const validIds = allAgents.map((a) => a.id);
    const mentions = extractMentions(content, validIds);
    const message = this.messages.insertAndJoinSender(
      channel.id,
      agentId,
      content,
      mentions
    );

    if (this.dispatch) {
      this.dispatch.dispatch({
        channelName,
        sender: agentId,
        content,
        messageId: message.id,
        isDm: true,
        targetAgents: [targetAgentId],
      });
    }

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

  readRecent(channelId: number, limit: number): Message[] {
    return this.messages.readRecent(channelId, limit);
  }

  getCursorPosition(agentId: string, channelId: number): number {
    return this.cursors.get(agentId, channelId);
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
