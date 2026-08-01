// Linear webhook JSON → channel message, or null for events the bridge
// ignores. Pure and defensive: Linear's payload shape varies by event type
// and evolves over time, so every field access tolerates absence.

export interface BridgeMessage {
  content: string;
  mentions: string[];
}

const COMMENT_EXCERPT_CHARS = 200;

type Obj = Record<string, unknown>;

function asObj(value: unknown): Obj | undefined {
  return typeof value === "object" && value !== null ? (value as Obj) : undefined;
}

function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function withUrl(text: string, url: string | undefined): string {
  return url ? `${text} ${url}` : text;
}

export function translate(payload: unknown): BridgeMessage | null {
  const p = asObj(payload);
  if (!p) return null;

  const type = asStr(p.type);
  const action = asStr(p.action);
  const data = asObj(p.data) ?? {};
  const url = asStr(p.url) ?? asStr(data.url);
  // Prototype scope: every handled event notifies the whole channel.
  const mentions = ["*"];

  if (type === "Issue") {
    const identifier = asStr(data.identifier) ?? "issue";
    const title = asStr(data.title) ?? "(untitled)";
    const stateName = asStr(asObj(data.state)?.name) ?? "unknown state";

    if (action === "create") {
      return {
        content: withUrl(`Linear ${identifier} created: ${title} (${stateName})`, url),
        mentions,
      };
    }
    if (action === "update") {
      // updatedFrom carries the pre-change values of changed fields; a stateId
      // key there is how a status transition is distinguished from edits to
      // title, assignee, etc., which the prototype ignores.
      const updatedFrom = asObj(p.updatedFrom);
      if (updatedFrom && "stateId" in updatedFrom) {
        return {
          content: withUrl(`Linear ${identifier} moved to ${stateName}: ${title}`, url),
          mentions,
        };
      }
      return null;
    }
    return null;
  }

  if (type === "Comment" && action === "create") {
    const issueIdentifier =
      asStr(asObj(data.issue)?.identifier) ?? asStr(data.issueId) ?? "issue";
    const body = asStr(data.body) ?? "";
    const excerpt = body.length > COMMENT_EXCERPT_CHARS ? body.slice(0, COMMENT_EXCERPT_CHARS) : body;
    return {
      content: withUrl(`Comment on ${issueIdentifier}: ${excerpt}`, url),
      mentions,
    };
  }

  return null;
}
