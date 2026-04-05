import type { MessagingService } from "../../core/messaging/service";
import type { AgentRepository, NotificationPort } from "../../core/ports";
import { log } from "../../log";

export function createClaudeNotifier(
  messaging: MessagingService,
  agents: AgentRepository,
  port: NotificationPort,
  agentId: string,
  intervalMs: number = 3000
): () => Promise<void> {
  const lastPushedId = new Map<number, number>();
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickPromise: Promise<void> | null = null;

  async function tick() {
    // Heartbeat
    const heartbeatResult = agents.heartbeatOrReclaim(agentId, process.pid);
    if (heartbeatResult === "lost") {
      active = false;
      return;
    }

    // Get pending notifications from core (domain logic)
    const pending = messaging.getUndelivered(agentId, lastPushedId);

    for (const notification of pending) {
      const messages = notification.messages;
      if (messages.length === 0) continue;

      const latest = messages[messages.length - 1]!;

      let content: string;
      if (messages.length === 1) {
        content = latest.content;
      } else {
        const MAX_PREVIEWS = 10;
        const shown = messages.slice(0, MAX_PREVIEWS);
        const previews = shown
          .map((m, i) =>
            `[${i + 1}] ${m.agent_id}: ${m.content.length > 150 ? m.content.slice(0, 147) + "..." : m.content}`
          )
          .join("\n");
        const remainder = messages.length > MAX_PREVIEWS
          ? `\n...and ${messages.length - MAX_PREVIEWS} more`
          : "";
        content = `${messages.length} new messages on ${notification.channelName}:\n${previews}${remainder}`;
      }

      const meta = {
        channel_name: notification.channelName,
        sender: latest.agent_id,
        message_id: String(latest.id),
      };

      try {
        await port.notify(content, meta);
        lastPushedId.set(messages[0]!.channel_id, latest.id);
      } catch (err) {
        log(`notify FAILED for ${agentId}: ${err}`);
        // Don't advance HWM on failure — retry next tick
      }
    }
  }

  function scheduleNext() {
    if (!active) return;
    timer = setTimeout(() => {
      tickPromise = (async () => {
        try {
          await tick();
        } catch (err) {
          log(`channel poll error: ${err}`);
        }
        tickPromise = null;
        scheduleNext();
      })();
    }, intervalMs);
    timer.unref();
  }

  scheduleNext();

  return async () => {
    active = false;
    if (timer !== null) clearTimeout(timer);
    if (tickPromise !== null) await tickPromise;
  };
}
