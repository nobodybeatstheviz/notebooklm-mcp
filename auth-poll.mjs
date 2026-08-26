// auth-poll.mjs — NotebookLM cookie capture with LOGIN AUTO-DETECT (no Enter needed).
// Same output as `dist/index.js --auth` (~/.notebooklm-cookies.json) but polls for
// login completion instead of waiting on stdin. Built 2026-07-15 because the
// interactive flow can't run from a background shell.
// Usage: node auth-poll.mjs   (browser opens → log in → auto-saves → closes)

import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import os from "os";

const SESSION_FILE = path.join(os.homedir(), ".notebooklm-cookies.json");
const URL = "https://notebooklm.google.com";
const POLL_MS = 3000;
const TIMEOUT_MS = 6 * 60 * 1000; // 6 minutes to log in

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

console.error("[auth-poll] Launching browser — log in with the Google account whose notebooks you want.");
const browser = await puppeteer.launch({
  headless: false,
  executablePath: CHROME,
  defaultViewport: null,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});

const page = await browser.newPage();
await page.goto(URL, { waitUntil: "networkidle2" }).catch(() => {});

console.error("[auth-poll] Waiting for login... (auto-detects, no Enter needed)");
const start = Date.now();
let session = null;

while (Date.now() - start < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  try {
    const url = page.url();
    if (url.includes("accounts.google.com")) continue; // still on login screens
    const { at, fsid } = await page.evaluate(() => {
      const wiz = window.WIZ_global_data ?? {};
      return { at: wiz.SNlM0e ?? "", fsid: wiz.FdrFJe ?? "" };
    });
    if (at) {
      const cookies = await page.cookies();
      if (cookies.some((c) => c.name === "SID" || c.name === "__Secure-1PSID")) {
        session = { cookies, at, fsid };
        break;
      }
    } else if (url.startsWith(URL)) {
      // On the app but WIZ not authed yet (or stale) — reload to refresh globals
      await page.reload({ waitUntil: "networkidle2" }).catch(() => {});
    }
  } catch {
    /* mid-navigation — keep polling */
  }
}

if (!session) {
  console.error("[auth-poll] TIMED OUT — no authenticated session detected. Nothing saved.");
  await browser.close();
  process.exit(1);
}

await browser.close();
await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf-8");
console.error(`[auth-poll] SUCCESS — saved ${session.cookies.length} cookies + XSRF token to ${SESSION_FILE}`);
