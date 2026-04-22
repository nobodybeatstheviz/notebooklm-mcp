import express from "express";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import {
  setMemorySession,
  cookiesFilePath,
  type SessionData,
} from "./auth.js";

const DEFAULT_PORT = 3000;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
}

export async function startHttpServer(port = DEFAULT_PORT): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const sessions = new Map<string, SessionEntry>();

  function removeSession(sessionId: string): void {
    sessions.delete(sessionId);
    console.error(`[http] Session ${sessionId} closed (${sessions.size} active)`);
  }

  // ── MCP endpoints ──────────────────────────────────────────────────────────

  app.post("/mcp", async (req, res) => {
    const incomingSessionId = req.headers["mcp-session-id"] as string | undefined;

    if (incomingSessionId && sessions.has(incomingSessionId)) {
      const { transport } = sessions.get(incomingSessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport });
        console.error(`[http] New session ${sessionId} (${sessions.size} active)`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) removeSession(transport.sessionId);
    };

    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Missing or invalid mcp-session-id header" });
      return;
    }
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    removeSession(sessionId);
  });

  // ── Auth cookie refresh endpoint ───────────────────────────────────────────
  // POST /auth/cookies  { "cookies": [...] }
  // Header: Authorization: Bearer <MCP_AUTH_SECRET>  (required if env var is set)

  app.post("/auth/cookies", async (req, res) => {
    const secret = process.env.MCP_AUTH_SECRET;
    if (secret) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${secret}`) {
        res.status(401).json({ error: "Unauthorized — provide Authorization: Bearer <MCP_AUTH_SECRET>" });
        return;
      }
    }

    // Accept full SessionData { cookies, at, fsid } or legacy { cookies }
    const body = req.body as Partial<SessionData>;
    if (!Array.isArray(body.cookies) || body.cookies.length === 0) {
      res.status(400).json({ error: 'Body must be { "cookies": [...], "at": "...", "fsid": "..." }' });
      return;
    }

    const session: SessionData = {
      cookies: body.cookies,
      at: body.at ?? "",
      fsid: body.fsid ?? "",
    };
    setMemorySession(session);

    // Best-effort write to disk for persistence across restarts
    try {
      await fs.writeFile(cookiesFilePath(), JSON.stringify(session, null, 2), "utf-8");
    } catch {
      // read-only filesystem on some platforms — in-memory is sufficient
    }

    console.error(`[auth] Session updated via API (${body.cookies.length} cookies)`);
    res.json({ ok: true, count: body.cookies.length });
  });

  // ── Health check ───────────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", sessions: sessions.size });
  });

  await new Promise<void>((resolve) => {
    app.listen(port, "0.0.0.0", () => {
      console.error(`[http] NotebookLM MCP server listening on http://0.0.0.0:${port}/mcp`);
      console.error(`[http] Cookie refresh endpoint: POST http://0.0.0.0:${port}/auth/cookies`);
      resolve();
    });
  });
}
