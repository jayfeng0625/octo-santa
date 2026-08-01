import { expect } from "bun:test";

// Captures what a register*() call would install on a real McpServer, so tool
// metadata and the structured-output contract can be asserted without a
// transport. Shared by the messaging and admin transport tests.
export function makeMockServer() {
  const configs: Record<string, any> = {};
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const resources: Record<
    string,
    { uri: string; config: any; read: (uri: URL) => Promise<any> }
  > = {};

  const server = {
    registerTool: (name: string, config: any, cb: (...args: any[]) => Promise<any>) => {
      configs[name] = config;
      handlers[name] = cb;
    },
    registerResource: (
      name: string,
      uri: string,
      config: any,
      read: (uri: URL) => Promise<any>
    ) => {
      resources[name] = { uri, config, read };
    },
  } as any;

  // Runs a tool and asserts the two halves of the structured-output contract:
  // structuredContent validates against the tool's declared outputSchema, and
  // the text block mirrors it exactly.
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await handlers[name]!(args);
    const parsed = configs[name].outputSchema.safeParse(result.structuredContent);
    expect(
      parsed.success,
      `${name} structuredContent vs outputSchema: ${JSON.stringify(parsed.error?.issues)}`
    ).toBe(true);
    expect(result.content[0].text, `${name} text mirrors structuredContent`).toBe(
      JSON.stringify(result.structuredContent)
    );
    return result.structuredContent;
  };

  return { server, configs, handlers, resources, invoke };
}
