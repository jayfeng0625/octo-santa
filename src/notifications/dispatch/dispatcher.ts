import type { NotificationDispatch, NotificationPort, NotificationMeta } from "../../core/ports";
import { log } from "../../log";

export function createNotificationDispatcher(): NotificationDispatch & {
  register(agentId: string, port: NotificationPort): void;
  unregister(agentId: string): void;
} {
  const handlers = new Map<string, NotificationPort>();
  return {
    dispatch(notification) {
      const meta: NotificationMeta = {
        channel_name: notification.channelName,
        sender: notification.sender,
        message_id: String(notification.messageId),
      };
      for (const agentId of notification.targetAgents) {
        const handler = handlers.get(agentId);
        if (!handler) continue;
        handler
          .notify(notification.content, meta)
          .catch((err) => log(`dispatch failed for ${agentId}: ${err}`));
      }
    },
    register(agentId, port) {
      handlers.set(agentId, port);
    },
    unregister(agentId) {
      handlers.delete(agentId);
    },
  };
}
