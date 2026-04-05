// src/core/brain/service.ts
import type { BrainStore, DomainRepository, AgentRepository } from "../ports";
import type { BrainDoc, DomainExpert, OctoSantaConfig } from "./types";
import { isAgentActive } from "../utils";

export class BrainService {
  constructor(
    private brainStore: BrainStore,
    private domains: DomainRepository,
    private agents: AgentRepository,
    private config: OctoSantaConfig | null,
    private pid: number
  ) {}

  index(): BrainDoc[] {
    return this.brainStore.scanDocs();
  }

  read(slug: string): string {
    return this.brainStore.readDoc(slug);
  }

  sharedIndex(): BrainDoc[] {
    return this.brainStore.scanSharedDocs();
  }

  sharedRead(slug: string): string {
    return this.brainStore.readSharedDoc(slug);
  }

  findExperts(): DomainExpert[] {
    const domainsWithClaims = this.domains.listWithClaims();
    return domainsWithClaims.map((d) => {
      const activeSessions = d.claims
        .filter((c) => isAgentActive(c.agent))
        .map((c) => c.agent_id);
      return {
        identifier: d.identifier,
        tags: JSON.parse(d.tags),
        description: d.description,
        active_sessions: activeSessions,
      };
    });
  }

  claimDomain(agentId: string): void {
    if (!this.config?.domain) throw new Error("No domain configured for this repo");
    const agent = this.agents.findById(agentId);
    if (!agent || agent.pid !== this.pid) {
      throw new Error("Must call messaging_register before brain_claim_domain");
    }
    this.domains.claim(agentId, this.pid, this.config.domain.identifier);
  }

  registerDomain(cwd: string): void {
    if (!this.config?.domain) return;
    const { identifier, tags, description } = this.config.domain;
    this.domains.register(identifier, cwd, tags, description);
  }

  onDisconnect(agentId: string, pid: number): void {
    this.domains.clearClaims(agentId, pid);
  }
}
