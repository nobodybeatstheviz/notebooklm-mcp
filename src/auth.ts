import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createInterface } from "readline";

const SESSION_FILE = path.join(os.homedir(), ".notebooklm-cookies.json");
const NOTEBOOKLM_URL = "https://notebooklm.google.com";

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export interface SessionData {
  cookies: CookieEntry[];
  at: string;   // XSRF token — required by batchexecute
  fsid: string; // f.sid — session ID for batchexecute query params
}

// In-memory session override (set via POST /auth/cookies at runtime)
let memorySession: SessionData | null = null;

export function setMemorySession(session: SessionData): void {
  memorySession = session;
}

export function setMemoryCookies(cookies: CookieEntry[]): void {
  // Legacy compat: build a session with just cookies, no at/fsid
  memorySession = { cookies, at: "", fsid: "" };
}

export function clearMemoryCookies(): void {
  memorySession = null;
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.CHROME_PATH,
].filter(Boolean) as string[];

async function findChrome(): Promise<string | undefined> {
  for (const p of CHROME_PATHS) {
    try {
      await fs.access(p);
      return p;
    } catch { /* try next */ }
  }
  return undefined;
}

export async function extractAndSaveCookies(): Promise<void> {
  console.error("[auth] Launching browser for Google NotebookLM login...");

  const executablePath = await findChrome();
  if (!executablePath) {
    throw new Error(
      "Could not find Chrome. Install Google Chrome or set CHROME_PATH env var."
    );
  }
  console.error(`[auth] Using Chrome at: ${executablePath}`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = await browser.newPage();
  await page.goto(NOTEBOOKLM_URL, { waitUntil: "networkidle2" });

  console.error("[auth] A browser window has opened. Please:");
  console.error("  1. Sign in with your Google account");
  console.error("  2. Reach the NotebookLM home page (notebooks listed)");

  await waitForEnter("[auth] Press Enter here once you are logged in...");

  const cookies = await page.cookies();

  // Extract XSRF token and session ID from Google's WIZ_global_data
  const { at, fsid } = await page.evaluate(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wiz = (window as any).WIZ_global_data ?? {};
      return {
        at: (wiz.SNlM0e as string) ?? "",
        fsid: (wiz.FdrFJe as string) ?? "",
      };
    } catch {
      return { at: "", fsid: "" };
    }
  });

  await browser.close();

  if (cookies.length === 0) {
    throw new Error("No cookies extracted — did you complete the login?");
  }

  const session: SessionData = { cookies, at, fsid };
  await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf-8");
  console.error(`[auth] Saved ${cookies.length} cookies to ${SESSION_FILE}`);
  if (at) console.error("[auth] XSRF token captured.");
  else console.error("[auth] Warning: XSRF token not found — API calls may fail.");
}

export async function loadSession(): Promise<SessionData | null> {
  // 1. In-memory override
  if (memorySession) return memorySession;

  // 2. Environment variable (JSON of SessionData or legacy cookie array)
  const envRaw = process.env.NOTEBOOKLM_COOKIES;
  if (envRaw) {
    try {
      const parsed = JSON.parse(envRaw);
      if (Array.isArray(parsed)) {
        // Legacy: plain cookie array
        return { cookies: parsed as CookieEntry[], at: "", fsid: "" };
      }
      return parsed as SessionData;
    } catch {
      console.error("[auth] Warning: NOTEBOOKLM_COOKIES env var is not valid JSON");
    }
  }

  // 3. File on disk
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy format: just a cookie array
      return { cookies: parsed as CookieEntry[], at: "", fsid: "" };
    }
    return parsed as SessionData;
  } catch {
    return null;
  }
}

/** Returns a Cookie header string, or null if no session exists. */
export async function loadCookieHeader(): Promise<string | null> {
  const session = await loadSession();
  if (!session) return null;
  return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export async function cookiesExist(): Promise<boolean> {
  if (memorySession) return true;
  if (process.env.NOTEBOOKLM_COOKIES) return true;
  try {
    await fs.access(SESSION_FILE);
    return true;
  } catch {
    return false;
  }
}

export function cookiesFilePath(): string {
  return SESSION_FILE;
}
