// src/transports/repl/startup.ts
import type { MessagingService } from "../../core/messaging/service";

export function startupRepl(svc: MessagingService, agentId: string, channel: string): string {
  const result = svc.register(agentId);
  const name = result.registeredName;
  svc.createChannel(name, channel);
  svc.subscribe(name, channel);
  return name;
}
