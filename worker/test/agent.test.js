import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postingMatches, isPageFurniture, lazyDocs, roleKey, nationalDigits } from '../apply/agent.js';

const intern = { title: 'Digital Marketing Intern', company: 'RBC' };

test('postingMatches: same posting, reworded heading', () => {
  assert.equal(postingMatches(intern, ['RBC Careers', 'Intern, Digital Marketing (Fall 2026)'], 'jobs.rbc.com rbc careers'), true);
  assert.equal(postingMatches({ title: 'Marketing Co-op - 4 months', company: 'Klick Inc.' }, ['Marketing Coop'], 'klick health'), true);
  assert.equal(postingMatches({ title: 'Digital Marketing Internship', company: 'DULCEDO' }, ['DULCEDO - Digital Marketing Intern'], 'jobs.lever.co/dulcedo'), true);
});

test('postingMatches: the RBC failure, right company but a senior role', () => {
  assert.equal(postingMatches(intern, ['Senior Director, Digital Marketing'], 'rbc royal bank'), false);
  assert.equal(postingMatches({ title: 'Marketing Intern', company: 'RBC' }, ['Sr. Manager, Marketing'], 'rbc'), false);
});

test('postingMatches: company name alone, or body text alone, is not enough', () => {
  assert.equal(postingMatches(intern, ['Careers at RBC', 'Search jobs'], 'rbc digital marketing intern listed somewhere in the body'), false);
});

test('postingMatches: right title at an unrelated employer (sponsored redirect)', () => {
  assert.equal(postingMatches({ title: 'Marketing Intern', company: 'Proax Technologies' }, ['Marketing Intern'], 'hellofresh.com careers hellofresh'), false);
});

test('postingMatches: an ATS that only names the posting in its URL slug (iCIMS login page)', () => {
  const job = { title: 'Winter Intern 2027– Business Analyst', company: 'Mackenzie Investments' };
  const text = 'https://careersen-mackenzieinvestments.icims.com/jobs/5997/x/login job opportunities';
  assert.equal(postingMatches(job, ['Job Opportunities'], text), false);
  assert.equal(postingMatches(job, ['Job Opportunities', ' jobs 5997 winter intern 2027– business analyst login'], text), true);
  assert.equal(postingMatches(job, ['Job Opportunities', ' jobs 6120 senior business analyst login'], text), false);
});

test('postingMatches: "intern" does not match "international", empty title never matches', () => {
  assert.equal(postingMatches({ title: 'Intern', company: '' }, ['International Sales'], ''), false);
  assert.equal(postingMatches({ title: '', company: 'RBC' }, ['Anything'], 'rbc'), false);
});

// Minimal stand-in for the DOM node isPageFurniture inspects in the browser.
function node({ type = 'text', attrs = {}, labels = [], inside = '', form = null }) {
  return {
    type,
    labels: labels.map((innerText) => ({ innerText })),
    getAttribute: (a) => attrs[a] ?? null,
    closest: (sel) => (sel === 'form' ? form && { getAttribute: (a) => form[a] ?? null } : inside && sel.includes(inside) ? {} : null),
  };
}

test('isPageFurniture: job alerts, newsletter, site search and sidebars are skipped', () => {
  assert.equal(isPageFurniture(node({ type: 'email', labels: ['Email me job alerts'] })), true);
  assert.equal(isPageFurniture(node({ attrs: { name: 'newsletter_email' } })), true);
  assert.equal(isPageFurniture(node({ type: 'search' })), true);
  assert.equal(isPageFurniture(node({ inside: 'aside' })), true);
  assert.equal(isPageFurniture(node({ form: { class: 'job-alert-signup' } })), true);
  assert.equal(isPageFurniture(node({ form: { action: '/search' } })), true);
});

test('isPageFurniture: bot traps are never typed into (Workday "beecatcher", "leave this field blank")', () => {
  assert.equal(isPageFurniture(node({ attrs: { 'data-automation-id': 'beecatcher', 'aria-label': 'Enter website. This input is for robots only, do not enter if you\'re human.' } })), true);
  assert.equal(isPageFurniture(node({ labels: ['Please leave this field blank'] })), true);
  assert.equal(isPageFurniture(node({ labels: ['Website, Blog or Portfolio'] })), false);
});

test('isPageFurniture: real application fields are kept, including Workday "Search" typeaheads', () => {
  assert.equal(isPageFurniture(node({ type: 'email', labels: ['Email'], form: { id: 'application-form', action: '/apply' } })), false);
  assert.equal(isPageFurniture(node({ attrs: { placeholder: 'Search', 'data-automation-id': 'searchBox' } })), false);
});

test('applyUrls: LinkedIn first, every source once, job-level URLs last', async () => {
  const { applyUrls } = await import('../apply/agent.js');
  const job = { sources: [{ name: 'ziprecruiter', url: 'https://zr/1' }, { name: 'linkedin', applyUrl: 'https://li/1', url: 'https://li/view' }, { name: 'glassdoor', url: 'https://zr/1' }], url: 'https://job/1' };
  assert.deepEqual(applyUrls(job), ['https://li/1', 'https://zr/1', 'https://job/1']);
  assert.deepEqual(applyUrls({}), []);
});

// Real browser: a visible reCAPTCHA frame blocks until its response token is filled in, which is
// what a user solving it does. Headless here; "headed" only switches the waiting logic on.
test('waitForHuman: waits while the CAPTCHA is unsolved, continues once the token appears', async () => {
  const { chromium } = await import('playwright');
  const { waitForHuman, detectPauseRaw } = await import('../apply/agent.js');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/recaptcha/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>checkbox</p>' }));
    await page.setContent(`<form><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x" width="304" height="78"></iframe>
      <textarea name="g-recaptcha-response" style="display:none"></textarea><button>Submit</button></form>
      <script>setTimeout(() => { document.querySelector('textarea').value = 'x'.repeat(400) }, 4000)</script>`);
    const pause = await detectPauseRaw(page);
    assert.equal(pause, 'captcha detected (recaptcha)');
    const logs = [];
    const ctx = { headed: false, job: { title: 'T', company: 'C' }, log: async (m) => logs.push(m) };
    assert.equal(await waitForHuman(page, ctx, pause), pause, 'a headless run never waits');
    ctx.headed = true;
    assert.equal(await waitForHuman(page, ctx, pause), null);
    assert.ok(logs.some((m) => /solved by the user/.test(m)));
  } finally {
    await browser.close();
  }
});

test('chatQuestion: pleasantries are dropped, statements are not questions', async () => {
  const { chatQuestion } = await import('../apply/agent.js');
  assert.equal(chatQuestion('Thanks for accepting our Terms of Use. What is your first and last name?'), 'What is your first and last name?');
  assert.equal(chatQuestion('Great, thanks Nirupam!'), '');
  assert.equal(chatQuestion('Got it. Please upload your resume.'), 'Please upload your resume.');
  const ack = 'I understand that this job requires a commitment to full-time hours (minimum 35 hours per week during standard business hours, Monday to Friday).';
  assert.equal(chatQuestion(`Thanks! ${ack}`), ack);
});

test('lazyDocs: nothing is prepared until a form asks for files, and then only once', async () => {
  let loads = 0;
  const docs = lazyDocs('a@b.ca', async () => { loads++; return { resumePath: '/tmp/r.pdf', coverPath: '/tmp/c.pdf' }; });
  assert.equal(docs.email, 'a@b.ca');
  assert.equal(loads, 0);
  await Promise.all([docs.ready(), docs.ready()]);
  assert.equal(loads, 1);
  assert.equal(docs.resumePath, '/tmp/r.pdf');
});

test('roleKey: the same opening under another city spelling is one role', () => {
  const a = { company: 'DULCEDO Management', title: 'Digital Marketing Intern', location: 'Greater Toronto Area, Canada' };
  assert.equal(roleKey(a), roleKey({ ...a, location: 'Toronto, Ontario, Canada' }));
  assert.notEqual(roleKey(a), roleKey({ ...a, title: 'Social Media Intern' }));
});

test('nationalDigits: the number a form with its own country-code box accepts', () => {
  assert.equal(nationalDigits('+1 (647) 642-3609'), '6476423609');
  assert.equal(nationalDigits('647-642-3609'), '6476423609');
  assert.equal(nationalDigits('+44 20 7946 0958'), '442079460958');
});
