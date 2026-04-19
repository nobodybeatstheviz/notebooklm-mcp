# CLAUDE.md — notebooklm-mcp

This file gives Claude Code instant context about this project.
Read this before making any changes.

---

## What this project is

A TypeScript MCP server that bridges Claude to Google NotebookLM via
reverse-engineered internal RPC APIs. Supports two transports:
- **stdio** — for Claude Desktop and Claude Code (local)
- **Streamable HTTP** — for Claude.ai chat and Cowork (deployed on Railway)

---

## Key architecture decisions

### Auth: cookies, not OAuth
NotebookLM has no public API. We extract real Google session cookies using
Puppeteer with `headless: false` + the user's real Chrome installation
(bundled Chromium gets blocked by Google). Cookies are saved to
`~/.notebooklm-cookies.json` as `{ cookies: [...], at: "xsrf_token", fsid: "session_id" }`.

The `at` (XSRF token) and `fsid` (session ID) are captured from
`window.WIZ_global_data.SNlM0e` and `window.WIZ_global_data.FdrFJe`
after login — both are required for batchexecute calls.

### Transport: Google batchexecute RPC (not REST)
Every operation uses:
```
POST /_/LabsTailwindUi/data/batchexecute
Content-Type: application/x-www-form-urlencoded
Body: f.req=[[["{RPC_ID}","{params_json}",null,"generic"]]]&at={xsrf}
```

Responses start with `)]}'\n` prefix (anti-JSON-hijacking). The parser
splits by newline, finds the `wrb.fr` chunk matching the RPC ID, and
parses the inner JSON string. See `parseBatchResponse()` in `notebooklm.ts`.

Chat uses a separate streaming endpoint — see `queryNotebook()`.

### Session data priority order
`loadSession()` in `auth.ts` checks in order:
1. In-memory override (set via `POST /auth/cookies` — used by Railway deployment)
2. `NOTEBOOKLM_COOKIES` environment variable (JSON string)
3. `~/.notebooklm-cookies.json` file on disk

---

## File map

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point — `--auth` / `--http` / stdio dispatch |
| `src/server.ts` | MCP tool definitions and `CallToolRequestSchema` handler |
| `src/notebooklm.ts` | All NotebookLM API calls + response parsers |
| `src/auth.ts` | Puppeteer cookie extraction, session loading/saving |
| `src/http.ts` | Express app with `/mcp` (StreamableHTTP) + `/auth/cookies` + `/health` |
| `src/types.ts` | Shared interfaces: `Notebook`, `Source`, `ChatResponse`, etc. |

---

## RPC method IDs

```
wXbhsf  — LIST_NOTEBOOKS      params: [null, 1, null, [2]]
CCqFvf  — CREATE_NOTEBOOK     params: [title, null, null, [2], [1]]
WWINqb  — DELETE_NOTEBOOK     params: [[notebookId], [2]]
rLM1Ne  — GET_NOTEBOOK        params: [notebookId, null, [2], null, 0]  (also lists sources)
izAoDd  — ADD_SOURCE          params vary by type (text/url) — see notebooklm.ts
tGMBJ   — DELETE_SOURCE       params: [[[sourceId]]]
R7cb6c  — CREATE_ARTIFACT     params: [[2], notebookId, [...audio config]]
```

---

## Response structure gotchas

### Notebook array (from LIST_NOTEBOOKS)
```
raw[0]  = title (string)
raw[1]  = sources (array — length = source_count)
raw[2]  = notebook ID (UUID string)
raw[3]  = emoji (string)
raw[5]  = metadata array (timestamps etc.)
```

### Source array (from GET_NOTEBOOK → nbInfo[1])
```
src[0][0]  = source ID
src[1]     = title
src[2][7][0] = URL (if URL source)
```

---

## Tools (10 total)

All registered in `src/server.ts` → `TOOLS` array and handled in the
`CallToolRequestSchema` switch statement.

```
notebooklm_auth_status       — no params
notebooklm_list_notebooks    — no params
notebooklm_create_notebook   — title: string
notebooklm_delete_notebook   — notebook_id: string
notebooklm_list_sources      — notebook_id: string
notebooklm_add_text_source   — notebook_id, title, content: string
notebooklm_add_url_source    — notebook_id, url: string
notebooklm_delete_source     — notebook_id, source_id: string
notebooklm_query             — notebook_id, query: string
notebooklm_generate_audio    — notebook_id: string
```

---

## Common tasks

### Add a new tool
1. Add the tool definition to the `TOOLS` array in `src/server.ts`
2. Add a `case` in the `CallToolRequestSchema` switch
3. Add the API function in `src/notebooklm.ts`
4. Run `npm run build`

### Re-authenticate
```bash
node dist/index.js --auth
```
Opens real Chrome, user logs in, press Enter — saves `~/.notebooklm-cookies.json`.

### Build & run locally
```bash
npm run build          # compile TypeScript → dist/
npm start              # stdio mode (Claude Desktop / Claude Code)
npm run start:http     # HTTP mode on port 3000 (Claude.ai)
```

### Deploy to Railway
```bash
git add -A && git commit -m "..." && git push
```
Railway auto-deploys on push. Set `NOTEBOOKLM_COOKIES` and `MCP_AUTH_SECRET`
env vars in the Railway dashboard.

### Refresh cookies on deployed server
```bash
curl -X POST https://YOUR-URL.up.railway.app/auth/cookies \
  -H "Authorization: Bearer YOUR_MCP_AUTH_SECRET" \
  -H "Content-Type: application/json" \
  -d "@~/.notebooklm-cookies.json"
```

---

## Known limitations

- **Cookie expiry**: Google sessions expire every few weeks. Re-run `--auth`.
- **Chat parsing**: The streaming chat response parser (`parseChat`) is best-effort.
  If answer extraction breaks, the raw response format likely changed — inspect
  the `wrb.fr` chunk structure and update the index path in `parseChat()`.
- **Audio polling**: `notebooklm_generate_audio` returns a task ID but doesn't
  poll for completion. Add a `notebooklm_get_audio_status` tool using
  `LIST_ARTIFACTS` RPC (`gArtLc`) to check status and get the audio URL.
- **No file upload**: File upload is a 3-step resumable upload flow
  (register → start session → stream bytes). Not yet implemented.
  See the `o4cbdc` RPC and `/upload/_/` endpoint if adding this.
