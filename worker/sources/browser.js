import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';

export const PROFILE_DIR = process.env.APPLYER_BROWSER || path.join(os.homedir(), '.applyer', 'browser');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// One persistent Chromium profile for every adapter, so cookies and consent
// choices survive between runs. Callers get a context and must close it.
// headed: a visible window, used only when the user has asked to solve a CAPTCHA themselves.
export async function openBrowser({ headed = false } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    channel: 'chromium',
    userAgent: UA,
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

// Serializes every caller (searchJobs, the apply agent) through one promise chain, since
// launchPersistentContext can only hold the profile lock once at a time. The chain itself
// never rejects, so one failed run doesn't wedge the queue for the next caller.
let chain = Promise.resolve();
export function withBrowser(fn, opts) {
  const run = async () => {
    const context = await openBrowser(opts);
    try {
      return await fn(context);
    } finally {
      await context.close().catch(() => {});
    }
  };
  const result = chain.then(run, run);
  chain = result.then(() => {}, () => {});
  return result;
}

const BLOCK_PATTERNS = [
  /just a moment/i,
  /verify you are human/i,
  /are you a human/i,
  /security verification/i,
  /access denied/i,
  /unusual traffic/i,
  /captcha/i,
  /challenge-platform/i,
  /px-captcha/i,
  /help us protect glassdoor/i,
  /security check/i,
];

// True when a page is a CAPTCHA, bot challenge, or login wall. We never try
// to get past these; the adapter records "blocked" and returns what it has.
export function looksBlocked({ url = '', title = '', html = '' }) {
  if (/\/login|\/authwall|\/checkpoint|\/account\/login/i.test(url)) return true;
  if (BLOCK_PATTERNS.some((re) => re.test(title))) return true;
  const head = html.slice(0, 20000);
  return BLOCK_PATTERNS.some((re) => re.test(head)) && !/job/i.test(title);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeJob(job) {
  const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
  return {
    title: clean(job.title),
    company: clean(job.company),
    location: clean(job.location),
    workMode: job.workMode || inferWorkMode(`${job.title} ${job.location} ${job.description || ''}`),
    salary: clean(job.salary) || null,
    employmentType: clean(job.employmentType) || inferEmploymentType(`${job.title} ${job.description || ''}`),
    description: job.description ? String(job.description).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim() : '',
    postedAt: job.postedAt instanceof Date && !Number.isNaN(job.postedAt.getTime()) ? job.postedAt : null,
    postedText: clean(job.postedText) || null,
    source: job.source,
    url: job.url,
    applyUrl: job.applyUrl || job.url,
    externalId: job.externalId ? String(job.externalId) : null,
  };
}

export function inferWorkMode(text) {
  const t = text.toLowerCase();
  if (/\bremote\b/.test(t) && !/not remote|no remote|on-?site only/.test(t)) return 'remote';
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\bon-?site\b|\bin-?office\b|\bin person\b/.test(t)) return 'onsite';
  return 'unknown';
}

export function inferEmploymentType(text) {
  const t = text.toLowerCase();
  if (/\bco-?op\b/.test(t)) return 'Co-op';
  if (/\bintern(ship)?\b/.test(t)) return 'Internship';
  if (/\bpart[- ]time\b/.test(t)) return 'Part-time';
  if (/\bcontract\b|\btemporary\b/.test(t)) return 'Contract';
  if (/\bfull[- ]time\b/.test(t)) return 'Full-time';
  return '';
}

// "3 days ago", "Posted 2 hours ago", "30+ days ago", "Just posted", "Today"
export function parseRelativeDate(text, now = new Date()) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (/just posted|today|just now|moments? ago|active/.test(t)) return now;
  if (/yesterday/.test(t)) return new Date(now.getTime() - 86400e3);
  const m = t.match(/(\d+)\+?\s*(minute|hour|day|week|month)/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 }[m[2]];
  return new Date(now.getTime() - n * unit);
}
