# notebooklm-mcp

A Model Context Protocol (MCP) server that connects Claude to Google NotebookLM.
Works with **Claude Desktop**, **Claude.ai chat**, **Claude Cowork**, and **Claude Code / VS Code**.

---

## What it does

Exposes 10 tools that let Claude read and write your NotebookLM notebooks:

| Tool | Description |
|---|---|
| `notebooklm_auth_status` | Check if your session cookies are valid |
| `notebooklm_list_notebooks` | List all notebooks in your account |
| `notebooklm_create_notebook` | Create a new notebook |
| `notebooklm_delete_notebook` | Delete a notebook |
| `notebooklm_list_sources` | List all sources in a notebook |
| `notebooklm_add_text_source` | Push raw text into a notebook as a source |
| `notebooklm_add_url_source` | Add a URL as a source (NotebookLM fetches & indexes it) |
| `notebooklm_delete_source` | Remove a source from a notebook |
| `notebooklm_query` | Ask a question, get a cited answer from the notebook's sources |
| `notebooklm_generate_audio` | Trigger a podcast-style Audio Overview |

---

## How it works

NotebookLM has no public API. This server reverse-engineers Google's internal
`batchexecute` RPC system used by the NotebookLM web UI. Authentication uses
real Google session cookies extracted once via Puppeteer (headless: false),
saved to `~/.notebooklm-cookies.json`, and reused for all API calls.

---

## Prerequisites

- **Node.js 20+**
- **Google Chrome** installed at the default path
- A Google account with access to [notebooklm.google.com](https://notebooklm.google.com)

---

## Setup

### 1. Install dependencies & build

```bash
git clone https://github.com/nobodybeatstheviz/notebooklm-mcp.git
cd notebooklm-mcp
npm install
npm run build
```

### 2. Authenticate (one-time)

```bash
node dist/index.js --auth
```

This opens your real Chrome browser (Google blocks sign-in from Puppeteer's
bundled Chromium). Sign in to your Google account, navigate to the NotebookLM
home page, then press **Enter** in the terminal.

Cookies are saved to `~/.notebooklm-cookies.json` and loaded automatically
on every server start.

> **When cookies expire** (typically every few weeks), just re-run `--auth`.

---

## Usage by client

### Claude Desktop (Windows)

Add to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\path\\to\\notebooklm-mcp\\dist\\index.js"]
    }
  }
}
```

Restart Claude Desktop — the NotebookLM tools appear in the hammer menu.

### Claude Code / VS Code

```bash
claude mcp add notebooklm node /full/path/to/notebooklm-mcp/dist/index.js
```

### Claude.ai Chat & Cowork (remote deployment)

The server supports **Streamable HTTP transport** for remote use.
Deploy to Railway (or any Docker host), then add the URL in
Claude.ai → Settings → Integrations.

See [Deployment](#deployment) below.

---

## Deployment (Railway)

### 1. Push to GitHub & connect Railway

```bash
git push origin main
```

Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub →
select this repo. Railway auto-detects the Dockerfile.

### 2. Set environment variables in Railway dashboard

| Variable | Value |
|---|---|
| `NOTEBOOKLM_COOKIES` | Full contents of `~/.notebooklm-cookies.json` (paste the JSON) |
| `MCP_AUTH_SECRET` | Any strong random string — protects the `/auth/cookies` endpoint |

### 3. Add to Claude.ai

Claude.ai → Settings → Integrations → Add MCP Server:
```
https://YOUR-RAILWAY-URL.up.railway.app/mcp
```

Same URL works in Cowork via the plug icon.

### Refreshing cookies on the deployed server

When your Google session expires, extract fresh cookies locally then push them:

```bash
# Step 1: re-run auth locally
node dist/index.js --auth

# Step 2: push to Railway (Windows CMD)
curl -X POST https://YOUR-RAILWAY-URL.up.railway.app/auth/cookies ^
  -H "Authorization: Bearer YOUR_MCP_AUTH_SECRET" ^
  -H "Content-Type: application/json" ^
  -d "@%USERPROFILE%\.notebooklm-cookies.json"
```

No redeploy needed — cookies update in memory instantly.

---

## Development

```bash
npm run dev        # TypeScript watch mode (recompiles on save)
npm run build      # One-off production build
npm start          # Run in stdio mode (Claude Desktop / Claude Code)
npm run start:http # Run HTTP server on port 3000 (Claude.ai)
npm run auth       # Extract Google session cookies via Puppeteer
```

### Project structure

```
src/
├── index.ts        # Entry point — routes --auth / --http / stdio
├── server.ts       # MCP Server: tool definitions + request handlers
├── notebooklm.ts   # NotebookLM API client (batchexecute RPC)
├── auth.ts         # Cookie extraction (Puppeteer) + session loading
├── http.ts         # Express server for Streamable HTTP transport
└── types.ts        # Shared TypeScript interfaces
```

### API internals

All operations (except chat) use Google's `batchexecute` endpoint:

```
POST https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute
Content-Type: application/x-www-form-urlencoded

f.req=[[["{RPC_ID}", "{params_json}", null, "generic"]]]&at={xsrf_token}
```

Responses start with `)]}'\n` (anti-hijacking prefix) followed by
newline-delimited JSON arrays. See `parseBatchResponse()` in `notebooklm.ts`.

Key RPC method IDs:

| Operation | RPC ID |
|---|---|
| List notebooks | `wXbhsf` |
| Create notebook | `CCqFvf` |
| Delete notebook | `WWINqb` |
| Get notebook / list sources | `rLM1Ne` |
| Add source | `izAoDd` |
| Delete source | `tGMBJ` |
| Generate audio | `R7cb6c` |

Chat uses a separate streaming endpoint:
`/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed`

---

## Troubleshooting

**"Not authenticated — run with --auth first"**
Run `node dist/index.js --auth` and complete the Google login flow.

**"Couldn't sign you in" in Puppeteer browser**
Puppeteer was using bundled Chromium. The server now uses your real Chrome
installation automatically. If Chrome is installed in a non-default location,
set `CHROME_PATH` env var before running `--auth`.

**Tools not showing up in Claude Desktop**
Start a new chat (tool list is cached per session). Also ensure you restarted
Claude Desktop after any config change.

**400 Bad Request from API**
Session cookies may be expired. Re-run `node dist/index.js --auth`.

---

## References

- [notebooklm-py](https://github.com/teng-lin/notebooklm-py) — Python implementation that informed the RPC endpoint discovery
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) — `@modelcontextprotocol/sdk` v1.x
- [MCP Spec — Streamable HTTP](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/)
