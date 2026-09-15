import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '../sources/browser.js';

const CREDS_PATH = path.join(os.homedir(), '.applyer', 'mail.json');

// Reads verification codes from the user's U of T mailbox through the Outlook web
// session already signed in inside the worker's browser profile. Takes the caller's
// Playwright context so it never competes for the persistent profile.
const MAIL_URL = 'https://outlook.office.com/mail/';
const CODE_RE = /\b(\d{4,8})\b/;

export async function readVerificationCode(context, { query = 'verification code', since = Date.now() - 15 * 60e3, timeoutMs = 4 * 60e3, log = async () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  const tab = await context.newPage();
  try {
    while (Date.now() < deadline) {
      await ensureMailbox(tab, log);
      const search = await tab.$('input[aria-label="Search"], #topSearchInput, input[placeholder="Search"]');
      if (!search) { await log('mail: search box not found, retrying'); await sleep(10_000); continue; }
      await search.click(); await search.fill(query); await tab.keyboard.press('Enter');
      await tab.waitForTimeout(5000);
      const rows = await tab.$$('div[role="option"], div[role="listbox"] div[role="row"]');
      for (const row of rows.slice(0, 5)) {
        await row.click(); await tab.waitForTimeout(3000);
        const pane = await tab.$('div[aria-label="Message body"], [role="document"], .allowTextSelection');
        const body = pane ? (await pane.innerText()).replace(/\s+/g, ' ') : '';
        const header = (await row.innerText()).replace(/\s+/g, ' ');
        if (!isFromToday(header)) continue; // Outlook shows a time for today's mail and a date for older mail
        const code = extractCode(body) || extractCode(header);
        const when = await messageTime(tab);
        if (code && (when == null || when >= since)) return { code, subject: header.slice(0, 120) };
      }
      await log('mail: no matching code yet, polling again in 20 s');
      await sleep(20_000);
    }
    return null;
  } finally {
    await tab.close();
  }
}

export function extractCode(text) {
  // Dates (7/20/2026, 2026-09-15) and phone numbers must never be mistaken for a code.
  const t = String(text || '').replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ' ').replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/\+?\d[\d\s().-]{8,}\d/g, ' ');
  const near = t.match(/(?:code|pin|passcode|verification)[^0-9]{0,40}(\d{4,8})\b/i);
  if (near) return near[1];
  const m = t.match(CODE_RE);
  return m ? m[1] : null;
}

async function messageTime(tab) {
  const el = await tab.$('div[aria-label="Message body"] ~ * time, [data-testid="SentReceivedSavedTime"], time');
  if (!el) return null;
  const dt = (await el.getAttribute('datetime')) || (await el.innerText());
  const ms = Date.parse(dt);
  return Number.isFinite(ms) ? ms : null;
}

// Opens the mailbox, signing in with the stored UTORid + password when Microsoft or the
// U of T IdP asks. Duo is passed silently by the remembered-device cookie; if Duo still
// wants a push (cookie expired), this waits up to two minutes for the user to approve it.
export async function ensureMailbox(tab, log = async () => {}) {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')).utoronto;
  const text = async () => (await tab.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
  const click = async (sel) => { const el = await tab.$(sel); if (el && (await el.isVisible())) { await el.click(); return true; } return false; };
  await tab.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  for (let i = 0; i < 40; i++) {
    try { await tab.waitForTimeout(4000); } catch { throw new Error('mail: page crashed during sign-in'); }
    const url = tab.url(); const t = await text();
    if (/outlook\.office\.com\/mail/.test(url) && !/login/.test(url) && /inbox|focused|new mail|folders/i.test(t)) return;
    if (/Pick an account/i.test(t) && (await click(`text=${creds.email}`))) continue;
    const email = await tab.$('input[name="loginfmt"]'); if (email && (await email.isVisible())) { await email.fill(creds.email); await tab.keyboard.press('Enter'); continue; }
    const user = await tab.$('input[name="j_username"], #username'); const pw = await tab.$('input[type="password"]');
    if (user && (await user.isVisible()) && pw) { await user.fill(creds.utorid); await pw.fill(creds.password); await tab.keyboard.press('Enter'); await log('mail: signed in to U of T'); continue; }
    if (await click('text=Approve with UTORMFA')) continue;
    if (await click('button:has-text("Send Me a Push"), button:has-text("Send me a push"), button:has-text("Duo Push")')) { await log('mail: Duo push sent, waiting for approval'); continue; }
    if (await click('button:has-text("Yes, this is my device"), button:has-text("Trust browser"), button:has-text("Yes, trust browser"), #trust-browser-button')) continue;
    if (await click('#idSIButton9, input[type="submit"][value="Yes"]')) continue;
  }
  throw new Error('mail: could not open the mailbox (sign-in did not complete)');
}

export function isFromToday(header) {
  const h = String(header || '');
  if (/\b\d{1,2}:\d{2}\s?(AM|PM)\b/i.test(h) && !/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(h)) return true;
  const today = new Date();
  const mdy = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
  return h.includes(mdy);
}
