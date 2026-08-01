import type { AdminModuleDescription } from "./types";

// Progressive disclosure for the admin API: instead of loading every module's
// full .d.ts into context, an agent searches these declarations by keyword and
// pulls in only the methods and types it needs, then writes code against them.
// Pure string logic over module-authored fragments, so any module that ships a
// .d.ts is searchable without core knowing what its API does.

export interface TypeheadEntry {
  // Module global the entry belongs to, e.g. "storage".
  module: string;
  // Method or type name, e.g. "sendMessage" or "MessageRecord". The module
  // global itself for the module's overview comment.
  name: string;
  // The declaration with its doc comment, exactly as authored.
  declaration: string;
}

export interface TypeheadSearchResult {
  matches: TypeheadEntry[];
  // Matches before the limit was applied, so callers know there were more.
  total: number;
}

export class TypeheadIndex {
  private readonly entries: IndexedEntry[];

  constructor(descriptions: AdminModuleDescription[]) {
    this.entries = descriptions.flatMap((d) =>
      parseFragment(d.globalName, d.typehead).map(indexEntry)
    );
  }

  search(query: string, limit: number): TypeheadSearchResult {
    const terms = tokenize(query);
    if (terms.length === 0) return { matches: [], total: 0 };
    const scored = this.entries
      .map((entry) => ({ entry, score: score(entry, terms) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return {
      matches: scored.slice(0, limit).map((s) => s.entry.entry),
      total: scored.length,
    };
  }
}

interface IndexedEntry {
  entry: TypeheadEntry;
  nameTokens: Set<string>;
  textTokens: Set<string>;
}

// Splits camelCase, snake_case, and punctuation into lowercase word tokens.
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function indexEntry(entry: TypeheadEntry): IndexedEntry {
  return {
    entry,
    nameTokens: new Set(tokenize(entry.name)),
    textTokens: new Set(tokenize(entry.declaration)),
  };
}

// Name hits count much more than body hits: an agent searching "send message"
// wants sendMessage(...) first, not every doc paragraph containing "message".
// A query that covers a name completely gets a further bonus, so sendMessage
// outranks SendMessageInput for "send message".
function score(entry: IndexedEntry, terms: string[]): number {
  let total = 0;
  let nameHits = 0;
  for (const term of new Set(terms)) {
    if (entry.nameTokens.has(term)) {
      total += 3;
      nameHits += 1;
    }
    if (entry.textTokens.has(term)) total += 1;
  }
  if (nameHits > 0 && nameHits === entry.nameTokens.size) total += 2;
  return total;
}

// Chunks a module's .d.ts fragment into entries: one per interface member
// (with its doc comment and enclosing interface named in the declaration),
// one per interface heading, one per top-level declaration, and one for the
// module's leading comment block (the overview — delivery model, invariants).
// Line-based on purpose: fragments are module-authored documentation, not
// arbitrary TypeScript, and a full parser would earn nothing here.
function parseFragment(module: string, fragment: string): TypeheadEntry[] {
  const entries: TypeheadEntry[] = [];
  const lines = fragment.split("\n");

  let pendingDoc: string[] = [];
  let currentInterface: string | null = null;
  let memberLines: string[] = [];
  let overview: string[] | null = [];

  const flushMember = () => {
    if (memberLines.length === 0) return;
    const signature = memberLines.join("\n");
    const name = signature.match(/^\s*(\w+)\s*[(?:<]/)?.[1];
    if (name !== undefined) {
      entries.push({
        module,
        name,
        declaration:
          `// ${module}: member of ${currentInterface}\n` +
          [...pendingDoc, ...memberLines].map((l) => l.trim()).join("\n"),
      });
    }
    memberLines = [];
    pendingDoc = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // The overview is everything before the first declaration.
    if (overview !== null) {
      if (trimmed.startsWith("interface ") || trimmed.startsWith("declare ")) {
        // Flush the overview only; a doc comment collected just above this
        // line belongs to the declaration, and falls through with it.
        const text = overview.join("\n").trim();
        if (text) entries.push({ module, name: module, declaration: text });
        overview = null;
      } else if (trimmed.startsWith("/**")) {
        // A doc comment this close to a declaration belongs to it, not to
        // the overview.
        pendingDoc.push(line);
        continue;
      } else if (pendingDoc.length > 0) {
        pendingDoc.push(line);
        continue;
      } else {
        overview.push(line);
        continue;
      }
    }

    if (currentInterface !== null) {
      if (trimmed === "}") {
        flushMember();
        currentInterface = null;
      } else if (trimmed.startsWith("/**") || trimmed.startsWith("*")) {
        pendingDoc.push(line);
      } else if (trimmed.startsWith("//")) {
        // Section dividers like "── Writing ──" — not part of any member.
      } else if (trimmed !== "") {
        memberLines.push(line);
        if (trimmed.endsWith(";")) flushMember();
      }
      continue;
    }

    if (trimmed.startsWith("/**") || trimmed.startsWith("*")) {
      pendingDoc.push(line);
      continue;
    }

    const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (interfaceMatch) {
      currentInterface = interfaceMatch[1]!;
      entries.push({
        module,
        name: currentInterface,
        declaration: [...pendingDoc, line].join("\n"),
      });
      pendingDoc = [];
      continue;
    }

    if (trimmed.startsWith("declare ")) {
      const name = trimmed.match(/^declare\s+(?:const|let|var|function)\s+(\w+)/)?.[1];
      entries.push({
        module,
        name: name ?? module,
        declaration: [...pendingDoc, line].join("\n"),
      });
      pendingDoc = [];
    }
  }

  return entries;
}
