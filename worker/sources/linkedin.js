import { looksBlocked, normalizeJob, parseRelativeDate, sleep } from './browser.js';

// LinkedIn public guest endpoints (no login). Search returns an HTML fragment
// of 10 cards per page; the posting endpoint returns the full description.
const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const POSTING = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';

export const name = 'linkedin';

export async function search({ query, location, page = 0 }, context) {
  const params = new URLSearchParams({
    keywords: query,
    location,
    start: String(page * 10),
    f_TPR: 'r2592000', // past 30 days
  });
  const url = `${SEARCH}?${params}`;
  const tab = await context.newPage();
  try {
    const res = await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = res ? res.status() : 0;
    const html = await tab.content();
    if (status === 429) return { jobs: [], status: 'blocked', message: 'rate limited (429)' };
    if (looksBlocked({ url: tab.url(), title: await tab.title(), html })) {
      return { jobs: [], status: 'blocked', message: `challenge or login wall at ${tab.url()}` };
    }
    if (status >= 400) return { jobs: [], status: 'error', message: `HTTP ${status}` };

    const cards = await tab.$$eval('li', (items) =>
      items
        .map((li) => {
          const card = li.querySelector('.base-card, .job-search-card');
          if (!card) return null;
          const link = li.querySelector('a.base-card__full-link, a.base-card__link');
          const urn = card.getAttribute('data-entity-urn') || '';
          const id = urn.split(':').pop() || (link && (link.href.match(/-(\d+)\?/) || [])[1]);
          const time = li.querySelector('time');
          return {
            externalId: id || null,
            title: li.querySelector('.base-search-card__title')?.textContent,
            company: li.querySelector('.base-search-card__subtitle')?.textContent,
            location: li.querySelector('.job-search-card__location')?.textContent,
            salary: li.querySelector('.job-search-card__salary-info')?.textContent,
            postedIso: time?.getAttribute('datetime') || null,
            postedText: time?.textContent,
            url: link ? link.href.split('?')[0] : null,
          };
        })
        .filter(Boolean),
    );
    const jobs = cards
      .filter((c) => c.title && c.url)
      .map((c) =>
        normalizeJob({
          ...c,
          source: name,
          postedAt: c.postedIso ? new Date(c.postedIso) : parseRelativeDate(c.postedText),
        }),
      );
    return { jobs, status: 'ok', message: `${jobs.length} cards` };
  } finally {
    await tab.close();
  }
}

// Fills in description and employment type for one job. Mutates and returns it.
export async function details(job, context) {
  if (!job.externalId) return job;
  const tab = await context.newPage();
  try {
    const res = await tab.goto(POSTING + job.externalId, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!res || res.status() >= 400) return job;
    const html = await tab.content();
    if (looksBlocked({ url: tab.url(), title: await tab.title(), html })) {
      job.detailsBlocked = true;
      return job;
    }
    const data = await tab.evaluate(() => {
      const desc = document.querySelector('.show-more-less-html__markup, .description__text');
      const criteria = {};
      document.querySelectorAll('.description__job-criteria-item').forEach((el) => {
        const k = el.querySelector('.description__job-criteria-subheader')?.textContent?.trim();
        const v = el.querySelector('.description__job-criteria-text')?.textContent?.trim();
        if (k && v) criteria[k] = v;
      });
      const apply = document.querySelector('a.apply-button, a[data-tracking-control-name*="apply"]');
      return { description: desc ? desc.innerText : '', criteria, applyUrl: apply ? apply.href : null };
    });
    job.description = data.description.trim();
    if (data.criteria['Employment type']) job.employmentType = data.criteria['Employment type'];
    if (data.criteria['Seniority level']) job.seniority = data.criteria['Seniority level'];
    if (data.applyUrl && !/linkedin\.com/.test(data.applyUrl)) job.applyUrl = data.applyUrl;
    await sleep(800 + Math.random() * 700);
    return job;
  } finally {
    await tab.close();
  }
}
