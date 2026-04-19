import type { Notebook, Source, ChatResponse, AudioStatus, ApiError } from "./types.js";
import { loadSession, cookiesExist, cookiesFilePath } from "./auth.js";
import { randomUUID } from "crypto";

const BASE_URL = "https://notebooklm.google.com";

// ── RPC method IDs (from reverse engineering) ─────────────────────────────────
const RPC = {
  LIST_NOTEBOOKS:   "wXbhsf",
  CREATE_NOTEBOOK:  "CCqFvf",
  GET_NOTEBOOK:     "rLM1Ne",
  DELETE_NOTEBOOK:  "WWINqb",
  ADD_SOURCE:       "izAoDd",
  DELETE_SOURCE:    "tGMBJ",
  CREATE_ARTIFACT:  "R7cb6c",
  LIST_ARTIFACTS:   "gArtLc",
} as const;

// ── batchexecute transport ────────────────────────────────────────────────────

async function buildCommonHeaders(cookie: string): Promise<HeadersInit> {
  return {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "Cookie": cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": BASE_URL + "/",
    "Origin": BASE_URL,
    "X-Goog-AuthUser": "0",
  };
}

/**
 * Call a single Google batchexecute RPC.
 * Returns the parsed inner JSON (result[0] etc.), ready to use.
 */
async function rpc<T>(
  rpcId: string,
  params: unknown[],
  sourcePath: string
): Promise<T> {
  const session = await loadSession();
  if (!session) {
    const err: ApiError = Object.assign(
      new Error("Not authenticated — run with --auth first"),
      { status: 401 }
    );
    throw err;
  }

  const cookie = session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const headers = await buildCommonHeaders(cookie);

  // Inner JSON: params serialised as a string inside the envelope
  const innerJson = JSON.stringify(params);
  const fReq = JSON.stringify([[[rpcId, innerJson, null, "generic"]]]);

  const qs = new URLSearchParams({
    rpcids: rpcId,
    "source-path": sourcePath,
    "f.sid": session.fsid ?? "",
    rt: "c",
  });

  const body = new URLSearchParams({ "f.req": fReq, at: session.at ?? "" });

  const res = await fetch(
    `${BASE_URL}/_/LabsTailwindUi/data/batchexecute?${qs}`,
    { method: "POST", headers, body: body.toString() }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err: ApiError = Object.assign(
      new Error(`NotebookLM RPC ${rpcId} failed ${res.status}: ${res.statusText}\n${text.slice(0, 300)}`),
      { status: res.status, body: text }
    );
    throw err;
  }

  const raw = await res.text();
  return parseBatchResponse<T>(raw, rpcId);
}

/**
 * Strip Google's )]}' prefix and extract the inner RPC payload.
 *
 * Google batchexecute responses look like:
 *   )]}'\r\n\r\n
 *   [["wrb.fr","rpcId","[[...data...]]",null,null,null,"generic"],[...],...]
 *   \n
 *   [["di",196]]
 *   \n
 *   ...
 *
 * Multiple JSON arrays are newline-delimited after the prefix — JSON.parse
 * only handles one at a time, so we split by line and search each chunk.
 */
function parseBatchResponse<T>(raw: string, rpcId: string): T {
  // Strip the )]}' prefix and any leading whitespace/newlines (handles \r\n too)
  const withoutPrefix = raw.replace(/^\)\]\}'[\r\n]+/, "");

  // Split into lines; each non-empty line starting with '[' is a JSON chunk
  const lines = withoutPrefix
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("["));

  for (const line of lines) {
    let chunk: unknown[][];
    try {
      chunk = JSON.parse(line) as unknown[][];
    } catch {
      continue; // malformed line — skip
    }

    // Each chunk is an array of items; find the wrb.fr entry for our rpcId
    for (const item of chunk) {
      if (!Array.isArray(item) || item[0] !== "wrb.fr") continue;
      if (item[1] !== rpcId) continue; // wrong RPC — keep looking
      const innerStr = item[2] as string | null;
      if (!innerStr) return null as unknown as T;
      return JSON.parse(innerStr) as T;
    }
  }

  // Fallback: return the first wrb.fr we find regardless of rpcId
  for (const line of lines) {
    let chunk: unknown[][];
    try { chunk = JSON.parse(line) as unknown[][]; } catch { continue; }
    for (const item of chunk) {
      if (Array.isArray(item) && item[0] === "wrb.fr" && item[2]) {
        return JSON.parse(item[2] as string) as T;
      }
    }
  }

  throw new Error(
    `No wrb.fr[${rpcId}] found in batchexecute response.\n` +
    `First 300 chars: ${raw.slice(0, 300)}`
  );
}

// ── Notebooks ─────────────────────────────────────────────────────────────────

export async function listNotebooks(): Promise<Notebook[]> {
  // Params: [null, 1, null, [2]]
  const result = await rpc<unknown[]>(RPC.LIST_NOTEBOOKS, [null, 1, null, [2]], "/");
  if (!Array.isArray(result)) return [];
  // result[0] is the array of raw notebook objects
  const raw = result[0] as unknown[][];
  if (!Array.isArray(raw)) return [];
  return raw.map(parseNotebook);
}

export async function createNotebook(title: string): Promise<Notebook> {
  // Params: ["<title>", null, null, [2], [1]]
  const result = await rpc<unknown[]>(RPC.CREATE_NOTEBOOK, [title, null, null, [2], [1]], "/");
  return parseNotebook(result);
}

export async function deleteNotebook(notebookId: string): Promise<void> {
  // Params: [["<notebookId>"], [2]]
  await rpc<unknown>(RPC.DELETE_NOTEBOOK, [[notebookId], [2]], "/");
}

function parseNotebook(raw: unknown[]): Notebook {
  return {
    id: String(raw[2] ?? ""),
    title: String(raw[0] ?? ""),
    emoji: raw[3] ? String(raw[3]) : undefined,
    source_count: Array.isArray(raw[1]) ? (raw[1] as unknown[]).length : 0,
  };
}

// ── Sources ───────────────────────────────────────────────────────────────────

export async function listSources(notebookId: string): Promise<Source[]> {
  // Uses GET_NOTEBOOK rpc — sources are in result[0][1]
  const result = await rpc<unknown[]>(
    RPC.GET_NOTEBOOK,
    [notebookId, null, [2], null, 0],
    `/notebook/${notebookId}`
  );
  if (!Array.isArray(result)) return [];
  const nbInfo = result[0] as unknown[][];
  if (!Array.isArray(nbInfo) || !Array.isArray(nbInfo[1])) return [];
  return (nbInfo[1] as unknown[][]).map((src) => parseSource(src, notebookId));
}

export async function addTextSource(
  notebookId: string,
  title: string,
  content: string
): Promise<Source> {
  // Params: [[[null, ["<title>", "<content>"], null×6]], "<notebookId>", [2], null, null]
  const result = await rpc<unknown[]>(
    RPC.ADD_SOURCE,
    [
      [[null, [title, content], null, null, null, null, null, null]],
      notebookId,
      [2],
      null,
      null,
    ],
    `/notebook/${notebookId}`
  );
  return parseSource(result, notebookId);
}

export async function addUrlSource(notebookId: string, url: string): Promise<Source> {
  // Params: [[[null, null, ["<url>"], null×5]], "<notebookId>", [2], null, null]
  const result = await rpc<unknown[]>(
    RPC.ADD_SOURCE,
    [
      [[null, null, [url], null, null, null, null, null]],
      notebookId,
      [2],
      null,
      null,
    ],
    `/notebook/${notebookId}`
  );
  return parseSource(result, notebookId);
}

export async function deleteSource(notebookId: string, sourceId: string): Promise<void> {
  // Params: [[["<sourceId>"]]]
  await rpc<unknown>(RPC.DELETE_SOURCE, [[[sourceId]]], `/notebook/${notebookId}`);
}

function parseSource(raw: unknown[], notebookId: string): Source {
  if (!Array.isArray(raw)) return { id: "", notebook_id: notebookId, type: "unknown" };
  // raw[0][0] = source id, raw[1] = title, raw[2][7][0] = url
  const idArr = raw[0] as unknown[];
  const id = Array.isArray(idArr) ? String(idArr[0] ?? "") : String(raw[0] ?? "");
  const title = raw[1] ? String(raw[1]) : undefined;
  let url: string | undefined;
  try {
    const meta = raw[2] as unknown[][];
    url = meta?.[7]?.[0] ? String(meta[7][0]) : undefined;
  } catch { /* no url */ }
  return {
    id,
    notebook_id: notebookId,
    title,
    type: url ? "url" : title ? "text" : "unknown",
    url,
  };
}

// ── Chat / Query ──────────────────────────────────────────────────────────────

export async function queryNotebook(
  notebookId: string,
  query: string
): Promise<ChatResponse> {
  const session = await loadSession();
  if (!session) {
    throw Object.assign(
      new Error("Not authenticated — run with --auth first"),
      { status: 401 } as Partial<ApiError>
    );
  }

  const cookie = session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const headers = await buildCommonHeaders(cookie);

  // Chat uses a different streaming endpoint
  const conversationId = randomUUID();
  const params: unknown[] = [
    [],               // source IDs (empty = all sources)
    query,
    null,             // no prior history
    [2, null, [1], [1]],
    conversationId,
    null,
    null,
    notebookId,
    1,
  ];

  const fReq = JSON.stringify([null, JSON.stringify(params)]);
  const reqid = String(Math.floor(Math.random() * 900000) + 100000);

  const qs = new URLSearchParams({
    bl: "boq_labs-tailwind-frontend_20260301.03_p0",
    hl: "en",
    _reqid: reqid,
    rt: "c",
    ...(session.fsid ? { "f.sid": session.fsid } : {}),
  });

  const body = new URLSearchParams({ "f.req": fReq, at: session.at ?? "" });

  const endpoint =
    `${BASE_URL}/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration` +
    `.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed`;

  const res = await fetch(`${endpoint}?${qs}`, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`Chat request failed ${res.status}: ${res.statusText}`),
      { status: res.status, body: text } as Partial<ApiError>
    );
  }

  const rawText = await res.text();
  return parseChat(rawText, conversationId);
}

function parseChat(raw: string, conversationId: string): ChatResponse {
  // Streaming responses: find the last complete wrb.fr chunk
  let answer = "";
  const stripped = raw.replace(/^\)\]\}'\n+/, "").trim();

  // The response may have multiple chunks; scan for the answer text
  try {
    const outer = JSON.parse(stripped) as unknown[][];
    for (const item of outer) {
      if (Array.isArray(item) && item[0] === "wrb.fr") {
        const innerStr = item[2] as string;
        if (!innerStr) continue;
        const inner = JSON.parse(innerStr) as unknown[];
        // Answer text is typically at inner[0][0] or inner[1][0]
        const candidate =
          (inner?.[0] as unknown[])?.[0] ??
          (inner?.[1] as unknown[])?.[0];
        if (typeof candidate === "string" && candidate.length > answer.length) {
          answer = candidate;
        }
      }
    }
  } catch {
    // Chunked streaming: try to extract any readable text blocks
    const matches = raw.matchAll(/"([^"]{20,})"/g);
    for (const m of matches) {
      if (m[1].length > answer.length && !m[1].startsWith("wrb")) {
        answer = m[1];
      }
    }
  }

  return {
    answer: answer || "(No answer extracted — the chat response format may have changed)",
    citations: [],
  };
}

// ── Audio ─────────────────────────────────────────────────────────────────────

export async function generateAudio(notebookId: string): Promise<AudioStatus> {
  // CREATE_ARTIFACT with type 1 (AUDIO), using all sources
  const sources = await listSources(notebookId);
  const sourceTriple = sources.map((s) => [[s.id]]);

  const result = await rpc<unknown[]>(
    RPC.CREATE_ARTIFACT,
    [
      [2],
      notebookId,
      [
        null,
        null,
        1, // ArtifactTypeCode.AUDIO
        sourceTriple,
        null,
        null,
        [
          null,
          [
            null,           // no custom instructions
            null,           // default length
            null,
            sources.map((s) => [s.id]),
            "en",
            null,
            null,           // default format (DEEP_DIVE)
          ],
        ],
      ],
    ],
    `/notebook/${notebookId}`
  );

  const taskId = Array.isArray(result) ? String(result[0] ?? "") : "";
  return {
    status: taskId ? "processing" : "failed",
    audio_url: undefined,
    transcript: taskId ? `Generation started. Task ID: ${taskId}` : undefined,
  };
}

// ── Auth status ───────────────────────────────────────────────────────────────

export async function getAuthStatus(): Promise<{
  authenticated: boolean;
  cookies_path: string;
  detail?: string;
}> {
  const exists = await cookiesExist();
  if (!exists) {
    return {
      authenticated: false,
      cookies_path: cookiesFilePath(),
      detail: "No session file found. Run: node dist/index.js --auth",
    };
  }

  try {
    await listNotebooks();
    return { authenticated: true, cookies_path: cookiesFilePath() };
  } catch (err) {
    const apiErr = err as ApiError;
    return {
      authenticated: false,
      cookies_path: cookiesFilePath(),
      detail:
        apiErr.status === 401 || apiErr.status === 403
          ? "Session expired — re-run: node dist/index.js --auth"
          : String(apiErr.message),
    };
  }
}
