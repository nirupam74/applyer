import { normalizeJob } from './browser.js';

// Hydro One's own careers site (SuccessFactors job board, public HTML, no login or challenge).
// A company site is not searched with the member's titles: it has its own short query list, and
// it only runs for members who list it in settings/jobs.companySources.
const BASE = 'https://jobs.hydroone.com';

export const name = 'hydroone';
export const queries = ['student', 'co-op', 'intern'];

export async function search({ query, page = 0 }, context) {
  const tab = await context.newPage();
  try {
    const res = await tab.goto(`${BASE}/search/?q=${encodeURIComponent(query)}&startrow=${page * 25}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = res ? res.status() : 0;
    if (status >= 400) return { jobs: [], status: 'error', message: `HTTP ${status}` };
    const cards = await tab.$$eval('tr.data-row', (rows) =>
      rows.map((tr) => {
        const link = tr.querySelector('a.jobTitle-link');
        return {
          title: link?.textContent,
          url: link ? link.href : null,
          location: tr.querySelector('.jobLocation')?.textContent,
          postedText: tr.querySelector('.jobDate')?.textContent,
        };
      }),
    );
    const jobs = cards
      .filter((c) => c.title && c.url)
      .map((c) => {
        const posted = new Date(String(c.postedText || '').trim());
        return normalizeJob({ ...c, company: 'Hydro One', source: name, externalId: (c.url.match(/\/(\d+)\/?$/) || [])[1] || null, postedAt: posted });
      });
    return { jobs, status: 'ok', message: `${jobs.length} rows` };
  } finally {
    await tab.close();
  }
}

// Fills in the description for one job. Mutates and returns it.
export async function details(job, context) {
  if (!job.url) return job;
  const tab = await context.newPage();
  try {
    const res = await tab.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!res || res.status() >= 400) return job;
    job.description = (await tab.locator('.jobdescription').first().innerText({ timeout: 5000 }).catch(() => '')).trim();
    return job;
  } finally {
    await tab.close();
  }
}
