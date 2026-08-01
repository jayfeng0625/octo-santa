import type { NotificationPort, NotificationMeta } from "../../core/ports";
import type { MessageWithChannel } from "../../core/messaging/types";
import { isDmChannel } from "../../core/utils";
import { log } from "../../log";

export function createNotificationPoller(opts: {
  getNewMessagesForAgent: (
    agentId: string,
    sinceId: number,
    limit: number
  ) => MessageWithChannel[];
  getMaxMessageId: () => number;
  port: NotificationPort;
  agentId: string;
  intervalMs?: number;
}): { start(): void; stop(): void; _tick(): Promise<void> } {
  const { getNewMessagesForAgent, getMaxMessageId, port, agentId, intervalMs = 2000 } = opts;
  let hwm = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    try {
      const messages = getNewMessagesForAgent(agentId, hwm, 100);
      // Channel-activity signal is unfiltered: every channel with new
      // messages this tick, whether or not any message mentions the agent.
      const activeChannels = new Set<string>();
      for (const msg of messages) {
        activeChannels.add(msg.channel_name);
        if (shouldNotifyMessage(msg.channel_name, msg.mentions)) {
          const meta: NotificationMeta = {
            channel_name: msg.channel_name,
            sender: msg.agent_id,
            message_id: String(msg.id),
          };
          port
            .notify(msg.content, meta)
            .catch((err) => log(`poller notify failed for message ${msg.id}: ${err}`));
        }
        if (msg.id > hwm) {
          hwm = msg.id;
        }
      }
      for (const channelName of activeChannels) {
        port
          .notifyChannelActivity?.(channelName)
          .catch((err) => log(`poller channel activity failed for ${channelName}: ${err}`));
      }
    } catch (err) {
      log(`poller tick error: ${err}`);
    }
  }

  function shouldNotifyMessage(channelName: string, mentionsJson: string): boolean {
    if (isDmChannel(channelName)) {
      return true;
    }
    try {
      const mentions: string[] = JSON.parse(mentionsJson);
      return mentions.includes(agentId) || mentions.includes("*");
    } catch {
      return false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      hwm = getMaxMessageId();
      timer = setInterval(() => {
        tick();
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    // Exposed so tests can drive polls without the timer.
    _tick: tick,
  };
}
