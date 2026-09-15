import { looksBlocked, normalizeJob, parseRelativeDate, sleep } from './browser.js';

// Indeed Canada public search (no login). 10 cards per page; the viewjob page
// carries the full description. Indeed sits behind Cloudflare, so a challenge
// page is common; we report it as blocked and never try to get past it.
const BASE = 'https://ca.indeed.com';
const CHALLENGE = '#challenge-running, iframe[src*="captcha"], .h-captcha, .cf-turnstile, #cf-chl-widget';

export const name = 'indeed';

// True when the page is a Cloudflare / CAPTCHA challenge or login wall.
async function challenged(tab) {
  const html = await tab.content();
  if (looksBlocked({ url: tab.url(), title: await tab.title(), html })) return true;
  return (await tab.$(CHALLENGE)) !== null;
}

export async function search({ query, location, page = 0 }, context) {
  const params = new URLSearchParams({ q: query, l: location, start: String(page * 10), fromage: '30' });
  const url = `${BASE}/jobs?${params}`;
  const tab = await context.newPage();
  try {
    const res = await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = res ? res.status() : 0;
    if (status === 429) return { jobs: [], status: 'blocked', message: 'rate limited (429)' };
    if (await challenged(tab)) {
      return { jobs: [], status: 'blocked', message: `challenge or login wall: "${await tab.title()}" at ${tab.url()}` };
    }
    if (status >= 400) return { jobs: [], status: 'error', message: `HTTP ${status}` };

    // ponytail: selectors are Indeed's known 2025 markup, unverified live (Cloudflare blocked inspection).
    const cards = await tab.$$eval('.job_seen_beacon, .resultContent', (items) =>
      items
        .map((card) => {
          const link = card.querySelector('a[data-jk], h2.jobTitle a');
          const jk = link?.getAttribute('data-jk') || (link?.href.match(/[?&]jk=([0-9a-f]+)/) || [])[1];
          if (!jk) return null;
          const snippets = [...card.querySelectorAll('[data-testid="attribute_snippet_testid"], .salary-snippet-container')]
            .map((el) => el.textContent.trim())
            .filter(Boolean);
          return {
            externalId: jk,
            title: link.querySelector('span[title]')?.getAttribute('title') || link.textContent,
            company: card.querySelector('[data-testid="company-name"]')?.textContent,
            location: card.querySelector('[data-testid="text-location"]')?.textContent,
            salary: snippets.find((s) => /\$/.test(s)) || null,
            employmentType: snippets.find((s) => !/\$/.test(s)) || null,
            postedText: card.querySelector('[data-testid="myJobsStateDate"], .date')?.textContent,
          };
        })
        .filter(Boolean),
    );
    const seen = new Set();
    const jobs = cards
      .filter((c) => c.title && !seen.has(c.externalId) && seen.add(c.externalId))
      .map((c) =>
        normalizeJob({
          ...c,
          source: name,
          url: `${BASE}/viewjob?jk=${c.externalId}`,
          postedText: c.postedText?.replace(/^(Posted|Employer|Active)\s*/i, ''),
          postedAt: parseRelativeDate(c.postedText),
        }),
      );
    return { jobs, status: 'ok', message: `${jobs.length} cards` };
  } finally {
    await tab.close();
  }
}

// Fills in description, salary and employment type for one job. Mutates and returns it.
export async function details(job, context) {
  if (!job.externalId) return job;
  const tab = await context.newPage();
  try {
    const res = await tab.goto(`${BASE}/viewjob?jk=${job.externalId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (await challenged(tab)) {
      job.detailsBlocked = true;
      return job;
    }
    if (!res || res.status() >= 400) return job;
    const data = await tab.evaluate(() => {
      const desc = document.querySelector('#jobDescriptionText, .jobsearch-JobComponent-description');
      const meta = document.querySelector('#salaryInfoAndJobType')?.innerText || '';
      return { description: desc ? desc.innerText : '', meta };
    });
    job.description = data.description.trim();
    const parts = data.meta.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
    const salary = parts.find((p) => /\$/.test(p));
    const type = parts.find((p) => !/\$/.test(p));
    if (salary) job.salary = salary;
    if (type) job.employmentType = type;
    await sleep(800 + Math.random() * 700);
    return job;
  } finally {
    await tab.close();
  }
}
