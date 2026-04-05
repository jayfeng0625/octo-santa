// src/transports/repl/startup.ts
import type { MessagingService } from "../../core/messaging/service";

export function startupRepl(svc: MessagingService, agentId: string, channel: string): void {
  svc.register(agentId);
  svc.createChannel(agentId, channel);
  svc.subscribe(agentId, channel);
}
