import { looksBlocked, normalizeJob, parseRelativeDate, sleep } from './browser.js';

// ZipRecruiter public search (no login). ziprecruiter.ca redirects here with
// country=ca; a Canadian location already yields Canadian results. Pages are
// 1-based path segments (/jobs-search/2). Each result is rendered as a card
// (company, location, salary) and mirrored in a JSON-LD ItemList that carries
// the canonical job URL with its jid; the two are zipped by position. Posted
// date lives only on the job page, so details() fills it.
const SEARCH = 'https://www.ziprecruiter.com/jobs-search';

export const name = 'ziprecruiter';

export async function search({ query, location, page = 0 }, context) {
  const params = new URLSearchParams({ search: query, location, days: '30' });
  const url = `${SEARCH}/${page + 1}?${params}`;
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

    const { cards, list } = await tab.evaluate(() => {
      const cards = [...document.querySelectorAll('div.job_result_two_pane_v2')].map((card) => {
        const text = (sel) => card.querySelector(sel)?.textContent || '';
        const loc = card.querySelector('[data-testid="job-card-location"]');
        return {
          title: text('[data-testid="serp-job-card-title"]'),
          company: text('[data-testid="job-card-company"]'),
          location: loc?.textContent,
          workMode: (loc?.nextElementSibling?.textContent || '').replace(/[^a-z-]/gi, '').toLowerCase() || null,
          salary: [...card.querySelectorAll('p')].map((p) => p.textContent).find((t) => /\$/.test(t)),
        };
      });
      let list = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(s.textContent);
          if (d['@type'] === 'ItemList') list = d.itemListElement;
        } catch {}
      }
      return { cards, list };
    });
    const jobs = list
      .map((item, i) => ({ ...cards[i], title: cards[i]?.title || item.name, url: item.url }))
      .filter((c) => c.title && c.url)
      .map((c) =>
        normalizeJob({
          ...c,
          workMode: /remote|hybrid|on-?site/.test(c.workMode || '') ? c.workMode.replace('-', '') : null,
          source: name,
          externalId: (c.url.match(/[?&]jid=([^&]+)/) || [])[1] || null,
        }),
      );
    return { jobs, status: 'ok', message: `${jobs.length} cards` };
  } finally {
    await tab.close();
  }
}

// Fills in description, posted date, employment type and salary for one job. Mutates and returns it.
export async function details(job, context) {
  if (!job.url) return job;
  const tab = await context.newPage();
  try {
    const res = await tab.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (res && [403, 429].includes(res.status())) job.detailsBlocked = true; // Cloudflare wall: say so, so the search stops asking
    if (!res || res.status() >= 400) return job;
    const html = await tab.content();
    if (looksBlocked({ url: tab.url(), title: await tab.title(), html })) {
      job.detailsBlocked = true;
      return job;
    }
    const data = await tab.evaluate(() => {
      const heading = [...document.querySelectorAll('h2')].find((h) => /^job description$/i.test(h.textContent.trim()));
      const desc = heading?.nextElementSibling;
      const facts = [...document.querySelectorAll('p')].map((el) => el.textContent.trim());
      return {
        description: desc ? desc.innerText : '',
        postedText: facts.find((t) => /^posted\b|\bago$|^today$/i.test(t)) || null,
        employmentType: facts.find((t) => /^(full|part)[- ]time$|^(contract|internship|temporary|co-op)$/i.test(t)) || null,
        salary: facts.find((t) => /^(CA|C)?\$/.test(t) && t.length < 60) || null,
      };
    });
    job.description = data.description.trim();
    if (data.postedText) Object.assign(job, { postedText: data.postedText, postedAt: parseRelativeDate(data.postedText) });
    if (data.employmentType) job.employmentType = data.employmentType;
    if (data.salary && !job.salary) job.salary = data.salary;
    await sleep(800 + Math.random() * 700);
    return job;
  } finally {
    await tab.close();
  }
}
