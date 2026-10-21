import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configFromEnv, type ApiConfig } from "./api.js";
import { render, tools } from "./tools.js";

export function createServer(cfg: ApiConfig): McpServer {
  const server = new McpServer({ name: "openterminal", version: "0.1.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.shape, annotations: { readOnlyHint: true, openWorldHint: false } },
      async (args: z.infer<z.ZodObject<z.ZodRawShape>>) => {
        try {
          return { content: [{ type: "text" as const, text: render(await tool.run(args, cfg), cfg.maxChars) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
        }
      },
    );
  }
  return server;
}

// Only start on stdio when run directly; tests import createServer.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const cfg = configFromEnv();
  if (!cfg.apiKey) console.error("[openterminal-mcp] no API key found (OPENTERMINAL_API_KEY or data/.api-key); requests will get 401");
  await createServer(cfg).connect(new StdioServerTransport());
}
