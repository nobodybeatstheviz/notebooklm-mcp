#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { extractAndSaveCookies } from "./auth.js";
import { createMcpServer } from "./server.js";
import { startHttpServer } from "./http.js";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  // --auth: one-time cookie extraction via Puppeteer
  if (args.includes("--auth")) {
    await extractAndSaveCookies();
    console.error("[auth] Authentication complete. You can now start the MCP server.");
    process.exit(0);
  }

  // --http [--port <n>]: Streamable HTTP transport (for Claude.ai)
  if (args.includes("--http")) {
    const portIdx = args.indexOf("--port");
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1] ?? "3000", 10) : 3000;
    await startHttpServer(port);
    return; // keep process alive
  }

  // Default: stdio transport (for Claude Code / local MCP clients)
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[stdio] NotebookLM MCP server running on stdio.");
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
