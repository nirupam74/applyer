import { looksBlocked, normalizeJob, parseRelativeDate, sleep } from './browser.js';

// Glassdoor Canada, no login. The simple jobs.htm form ignores locKeyword and
// searches all of Canada, so known cities get the canonical SRCH slug URL
// (…/toronto-on-digital-marketing-intern-jobs-SRCH_IL.0,10_IC2281069_KO11,35.htm).
// Pages are an _IP2, _IP3 suffix. Standalone job-listing pages sit behind a
// Cloudflare challenge after the first free page view, so details() is often blocked.
const BASE = 'https://www.glassdoor.ca';
// ponytail: ids read from live card URLs (JV_IC<id>); unknown cities fall back to Canada-wide
const CITY = { toronto: 2281069, mississauga: 2280741, montreal: 2296722, vancouver: 2278756, calgary: 2275123, edmonton: 2274961, ottawa: 2286068 };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const name = 'glassdoor';
export const knowsLocation = (location) => !!CITY[slug(location).split('-')[0]];

function searchUrl(query, location, page) {
  const id = CITY[slug(location).split('-')[0]];
  const ip = page > 0 ? `_IP${page + 1}` : '';
  if (!id) return `${BASE}/Job/jobs.htm?sc.keyword=${encodeURIComponent(query)}&locT=C&locKeyword=${encodeURIComponent(location)}`;
  const l = slug(location);
  const k = slug(query);
  return `${BASE}/Job/${l}-${k}-jobs-SRCH_IL.0,${l.length}_IC${id}_KO${l.length + 1},${l.length + 1 + k.length}${ip}.htm`;
}

export async function search({ query, location, page = 0 }, context) {
  const tab = await context.newPage();
  try {
    const res = await tab.goto(searchUrl(query, location, page), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = res ? res.status() : 0;
    await tab.waitForSelector('li[data-test="jobListing"]', { timeout: 10_000 }).catch(() => {});
    const html = await tab.content();
    if (status === 429) return { jobs: [], status: 'blocked', message: 'rate limited (429)' };
    if (looksBlocked({ url: tab.url(), title: await tab.title(), html })) {
      return { jobs: [], status: 'blocked', message: `challenge or login wall at ${tab.url()}: ${await tab.title()}` };
    }
    if (status >= 400) return { jobs: [], status: 'error', message: `HTTP ${status}` };

    const cards = await tab.$$eval('li[data-test="jobListing"]', (items) =>
      items.map((li) => {
        const link = li.querySelector('a[data-test="job-title"]');
        return {
          externalId: li.getAttribute('data-jobid') || (link && (link.href.match(/[?&]jl=(\d+)/) || [])[1]) || null,
          title: link?.textContent,
          company: li.querySelector('[class*="EmployerProfile_compactEmployerName"]')?.textContent,
          location: li.querySelector('[data-test="emp-location"]')?.textContent,
          salary: li.querySelector('[data-test="detailSalary"]')?.textContent?.replace(/\((Employer provided|Glassdoor est\.)\)/i, ''),
          postedText: li.querySelector('[data-test="job-age"]')?.textContent,
          // cards link to fr.glassdoor.ca; keep the English site
          url: link ? link.href.split('?')[0].replace(/^https:\/\/fr\./, 'https://www.') : null,
        };
      }),
    );
    // card age is "11d", "3h", "30d+"; expand the unit for parseRelativeDate
    const age = (t) => String(t || '').replace(/(\d+)\+?\s*([hd])\b/, (_, n, u) => `${n} ${u === 'h' ? 'hour' : 'day'}s ago`);
    const jobs = cards
      .filter((c) => c.title && c.url)
      .map((c) => normalizeJob({ ...c, source: name, postedAt: parseRelativeDate(age(c.postedText)) }));
    return { jobs, status: 'ok', message: `${jobs.length} cards at ${tab.url()}` };
  } finally {
    await tab.close();
  }
}

// Fills in description and salary for one job. Mutates and returns it.
// Glassdoor shows a sign-in modal after the first free page view; the description
// usually stays readable behind it. We press Escape once and never go further.
export async function details(job, context) {
  if (!job.url) return job;
  const tab = await context.newPage();
  try {
    const res = await tab.goto(`${job.url}?jl=${job.externalId || ''}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await tab.waitForSelector('[class*="JobDetails_jobDescription"]', { timeout: 10_000 }).catch(() => {});
    if (looksBlocked({ url: tab.url(), title: await tab.title(), html: await tab.content() })) {
      job.detailsBlocked = true;
      return job;
    }
    if (!res || res.status() >= 400) return job;
    await tab.keyboard.press('Escape');
    const data = await tab.evaluate(() => {
      const desc = document.querySelector('[class*="JobDetails_jobDescription"]');
      return {
        description: desc ? desc.innerText || desc.textContent : '',
        salary: document.querySelector('[data-test="detailSalary"]')?.textContent?.trim() || '',
        modal: !!document.querySelector('[data-test="authModalContainer"], [role="dialog"] input[type="email"]'),
      };
    });
    job.description = data.description.replace(/\s*Show (more|less)\s*$/, '').trim();
    if (data.salary && !job.salary) job.salary = data.salary;
    if (data.modal && !job.description) job.detailsBlocked = true;
    await sleep(800 + Math.random() * 700);
    return job;
  } finally {
    await tab.close();
  }
}
