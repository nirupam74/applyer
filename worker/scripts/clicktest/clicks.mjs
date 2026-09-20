// Pass 2: real clicks. Account 1 = full interaction with snapshot + restore of everything written. Account 2 = read-only clicks.
import admin from 'firebase-admin';
import { chromium } from 'playwright';
import fs from 'node:fs';
import { session, watch } from './crawl.mjs';
const BASE = process.env.BASE || 'https://applyer-jobs.web.app';
const db = admin.firestore();
const ME = 'MEMBER1_UID';
const HER = 'MEMBER2_UID';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const results = [];
let errors = [];
async function step(name, fn) {
  if (ONLY.length && !ONLY.some((o) => name.startsWith(o))) return;
  errors.length = 0;
  try {
    const note = await fn();
    const bad = errors.filter((e) => !/identitytoolkit|status of 400/.test(e));
    results.push(`${bad.length ? 'FAIL' : 'PASS'}  ${name}${note ? ' :: ' + note : ''}${bad.length ? ' :: ' + bad.join(' ;; ') : ''}`);
  } catch (e) {
    results.push(`FAIL  ${name} :: ${String(e.message || e).split('\n')[0].slice(0, 250)}${errors.length ? ' :: ' + errors.join(' ;; ') : ''}`);
  }
  console.log(results[results.length - 1]);
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = 'condition') { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(400); } throw new Error('timed out waiting for ' + label); }
async function open(ctx, route) { const p = await ctx.newPage(); watch(p, errors); await p.goto(BASE + route, { waitUntil: 'load' }); await p.waitForTimeout(2500); return p; }
async function download(page, locator) { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), locator.click()]); const path = await d.path(); const b = fs.readFileSync(path); return { name: d.suggestedFilename(), size: b.length, magic: b.subarray(0, 4).toString('latin1') }; }
const okFile = (f) => { assert(f.size > 5000, `file too small: ${f.size}`); assert(f.name.endsWith('.pdf') ? f.magic === '%PDF' : f.magic.startsWith('PK'), `bad magic ${JSON.stringify(f.magic)} for ${f.name}`); return `${f.name} ${Math.round(f.size / 1024)} KB`; };

const browser = await chromium.launch();

// ---------- account 1 ----------
{
  const ctx = await session(browser, ME);
  const busy = (await db.collection(`users/${ME}/tasks`).where('status', 'in', ['queued', 'running']).get()).size + (await db.collection(`users/${HER}/tasks`).where('status', 'in', ['queued', 'running']).get()).size;

  await step('shell: client-side nav through every page and back (unmount path)', async () => {
    const p = await open(ctx, '/home');
    for (const label of ['Jobs', 'Applications', 'Resume', 'Profile', 'Assistant', 'Home', 'Assistant', 'Jobs']) {
      await p.locator('header, nav').getByRole('link', { name: label, exact: true }).first().click();
      await p.waitForTimeout(1200);
      assert((await p.locator('main h1, h1').first().innerText()).trim() === label, `h1 is not ${label}`);
    }
    await p.close();
  });

  await step('shell: theme toggle persists, user menu opens', async () => {
    const p = await open(ctx, '/home');
    const before = await p.evaluate(() => document.documentElement.className + '|' + document.documentElement.dataset.theme);
    await p.getByRole('button', { name: /Switch to (dark|light)/ }).first().click();
    const after = await p.evaluate(() => document.documentElement.className + '|' + document.documentElement.dataset.theme);
    assert(before !== after, 'theme attribute did not change');
    await p.reload(); await p.waitForTimeout(1500);
    assert((await p.evaluate(() => document.documentElement.className + '|' + document.documentElement.dataset.theme)) === after, 'theme not kept after reload');
    await p.getByRole('button', { name: /Switch to (dark|light)/ }).first().click();
    await p.getByRole('button', { name: /nirupam\.gupta90|^N$/ }).first().click();
    await until(() => p.getByRole('button', { name: /sign out/i }).first().isVisible(), 3000, 'Sign out in the user menu');
    await p.close();
  });

  await step('shell (phone 390): hamburger opens nav, link navigates', async () => {
    const m = await session(browser, ME, { width: 390, height: 844 });
    const p = await open(m, '/home');
    await p.locator('header button').first().click();
    await p.getByRole('link', { name: 'Applications', exact: true }).last().click();
    await p.waitForTimeout(1500);
    assert(p.url().endsWith('/applications'), 'did not navigate: ' + p.url());
    await m.close();
  });

  let jobId;
  await step('jobs: search box, score, and every filter select', async () => {
    const p = await open(ctx, '/jobs');
    const rows = () => p.locator('main a[href^="/jobs/"]').count();
    const all = await rows();
    assert(all > 10, `only ${all} rows`);
    await p.getByPlaceholder(/Search title/).fill('scotiabank');
    await p.waitForTimeout(600);
    const some = await rows();
    assert(some > 0 && some < all, `search gave ${some} of ${all}`);
    await p.getByPlaceholder(/Search title/).fill('zzzz-no-such');
    await p.waitForTimeout(600);
    assert((await rows()) === 0, 'nonsense search still shows rows');
    await p.getByPlaceholder(/Search title/).fill('');
    const counts = [];
    const selects = p.locator('main select');
    for (let i = 0; i < (await selects.count()); i++) {
      const opts = await selects.nth(i).locator('option').evaluateAll((o) => o.map((x) => x.value));
      for (const v of opts.slice(1)) { await selects.nth(i).selectOption(v); await p.waitForTimeout(250); counts.push(await rows()); }
      await selects.nth(i).selectOption(opts[0]);
    }
    await p.locator('main input[type=number]').first().fill('85');
    await p.waitForTimeout(500);
    const hi = await rows();
    assert(hi > 0 && hi < all, `score 85 gave ${hi} of ${all}`);
    await p.locator('main input[type=number]').first().fill('70');
    await p.waitForTimeout(500);
    await p.locator('main a[href^="/jobs/"]').first().click();
    await p.waitForTimeout(2000);
    jobId = p.url().split('/jobs/')[1];
    assert(jobId && (await p.getByRole('button', { name: 'Resume PDF' }).isVisible()), 'job page did not open from the row');
    await p.getByRole('link', { name: 'Back to jobs' }).click();
    await p.waitForTimeout(1000);
    assert(p.url().endsWith('/jobs'), 'Back to jobs failed');
    await p.close();
    return `${all} rows, scotiabank ${some}, score>=85 ${hi}, ${counts.length} filter options exercised`;
  });

  await step('job page: four downloads', async () => {
    const p = await open(ctx, `/jobs/${jobId}`);
    const out = [];
    for (const n of ['Resume PDF', 'Resume DOCX', 'Cover letter PDF', 'Cover letter DOCX']) out.push(okFile(await download(p, p.getByRole('button', { name: n }))));
    const href = await p.getByRole('link', { name: 'Open posting' }).getAttribute('href');
    assert(/^https?:\/\//.test(href || ''), 'Open posting has no URL');
    await p.close();
    return out.join(', ');
  });

  await step('job page + applications: Save, Mark applied, status select, notes (restored after)', async () => {
    const ref = db.doc(`users/${ME}/jobs/${jobId}`);
    const before = (await ref.get()).data();
    try {
      const p = await open(ctx, `/jobs/${jobId}`);
      await p.getByRole('button', { name: /^Save/ }).click();
      await until(async () => (await ref.get()).data().status === 'saved', 6000, 'status saved');
      await p.getByRole('button', { name: 'Mark applied' }).click();
      await until(async () => { const d = (await ref.get()).data(); return d.status === 'applied' && d.appliedAt; }, 6000, 'status applied + appliedAt');
      await p.close();
      const a = await open(ctx, '/applications');
      const row = a.locator('main li, main tr, main div').filter({ hasText: before.title }).filter({ has: a.locator('select') }).last();
      await row.locator('select').selectOption('interview');
      await until(async () => (await ref.get()).data().status === 'interview', 6000, 'status interview');
      const notes = row.locator('input').first();
      await notes.fill('click test note');
      await notes.blur();
      await until(async () => (await ref.get()).data().notes === 'click test note', 6000, 'notes saved');
      await a.close();
    } finally {
      const F = admin.firestore.FieldValue;
      await ref.update({ status: before.status, appliedAt: before.appliedAt ?? F.delete(), notes: before.notes ?? F.delete(), updatedAt: before.updatedAt ?? F.delete() });
    }
    return 'job restored to ' + before.status;
  });

  await step('resume: open a version, compare view, downloads, page limit, default, rename, delete a throwaway copy', async () => {
    const sref = db.doc(`users/${ME}/settings/resume`);
    const sBefore = (await sref.get()).data();
    const src = (await db.collection(`users/${ME}/resumeVersions`).orderBy('createdAt', 'desc').limit(1).get()).docs[0];
    const copy = db.collection(`users/${ME}/resumeVersions`).doc();
    await copy.set({ ...src.data(), label: 'ZZ click test copy', createdAt: admin.firestore.Timestamp.now(), jobId: null });
    const notes = [];
    try {
      const p = await open(ctx, '/resume');
      p.on('dialog', (d) => d.accept());
      const row = p.locator('main li, main [role=button], main div').filter({ hasText: 'ZZ click test copy' }).filter({ has: p.getByRole('button', { name: 'Delete' }) }).last();
      await row.click({ position: { x: 5, y: 5 } });
      await until(() => p.getByRole('button', { name: 'Download DOCX' }).isVisible(), 8000, 'compare view');
      notes.push(okFile(await download(p, p.getByRole('button', { name: 'Download DOCX' }))));
      notes.push(okFile(await download(p, p.getByRole('button', { name: 'Download PDF' }))));
      assert((await p.getByRole('button', { name: /^Regenerate / }).count()) >= 5, 'regenerate buttons missing');
      await p.locator('main select').first().selectOption('2');
      await until(async () => (await sref.get()).data()?.maxPages === 2, 6000, 'maxPages 2');
      await p.locator('main select').first().selectOption(String(sBefore?.maxPages || 1));
      await row.getByRole('button', { name: 'Set as default' }).click();
      await until(async () => (await sref.get()).data()?.defaultVersionId === copy.id, 6000, 'defaultVersionId');
      await row.getByRole('button', { name: 'ZZ click test copy' }).click();
      const input = row.locator('input').first();
      await input.fill('ZZ renamed');
      await input.blur();
      await until(async () => (await copy.get()).data().label === 'ZZ renamed', 6000, 'label saved');
      await p.locator('main li, main div').filter({ hasText: 'ZZ renamed' }).filter({ has: p.getByRole('button', { name: 'Delete' }) }).last().getByRole('button', { name: 'Delete' }).click();
      await until(async () => !(await copy.get()).exists, 6000, 'version deleted');
      await p.close();
    } finally {
      await copy.delete().catch(() => {});
      await (sBefore ? sref.set(sBefore) : sref.delete());
    }
    return notes.join(', ');
  });

  await step('profile: text field, chips, one-per-line field autosave (whole doc restored after)', async () => {
    const ref = db.doc(`users/${ME}/profile/profile`);
    const before = (await ref.get()).data();
    let note;
    try {
      const p = await open(ctx, '/profile');
      const site = p.locator('main label', { hasText: /^Website/ }).locator('input').first().or(p.locator('main input').nth(5));
      const old = await site.inputValue();
      await site.fill(old + 'x');
      await site.blur();
      await until(async () => JSON.stringify((await ref.get()).data().personal).includes(old + 'x'), 8000, 'text field saved');
      const ta = p.locator('main textarea').last();
      const taOld = await ta.inputValue();
      await ta.fill((taOld ? taOld + '\n' : '') + 'Click test line');
      await ta.blur();
      await until(async () => JSON.stringify((await ref.get()).data()).includes('Click test line'), 8000, 'line field saved');
      note = `textareas ${await p.locator('main textarea').count()}, inputs ${await p.locator('main input').count()}`;
      await p.close();
    } finally {
      await wait(1500);
      await ref.set(before);
    }
    const after = (await ref.get()).data();
    assert(after.updatedAt.isEqual(before.updatedAt) && !JSON.stringify(after).includes('Click test line'), 'profile was not restored');
    return note + ', restored incl. updatedAt';
  });

  await step('jobs: Prepare documents button queues a task that finishes', async () => {
    assert(!busy, 'a task was already running, skipped');
    const t0 = admin.firestore.Timestamp.now();
    const p = await open(ctx, '/jobs');
    await p.getByRole('button', { name: 'Prepare documents' }).click();
    const task = await until(async () => (await db.collection(`users/${ME}/tasks`).where('createdAt', '>=', t0).get()).docs.find((d) => d.data().type === 'prepareBatch'), 8000, 'prepareBatch task');
    const done = await until(async () => { const d = (await task.ref.get()).data(); return ['done', 'failed'].includes(d.status) && d; }, 600000, 'prepareBatch to finish');
    await p.close();
    assert(done.status === 'done', 'task failed: ' + done.error);
    return `task ${task.id} ${done.status}: ${(done.log || []).slice(-2, -1)[0]?.slice(25) || ''}`;
  });

  await step('job page: Make again queues prepareDocuments, finishes, page shows the new time', async () => {
    assert(!busy, 'a task was already running, skipped');
    const ref = db.doc(`users/${ME}/jobs/${jobId}`);
    const was = (await ref.get()).data().docs.preparedAt.toMillis();
    const p = await open(ctx, `/jobs/${jobId}`);
    await p.getByRole('button', { name: 'Make again' }).click();
    await until(async () => (await ref.get()).data().docs.preparedAt.toMillis() > was, 420000, 'new documents');
    await p.waitForTimeout(2000);
    okFile(await download(p, p.getByRole('button', { name: 'Resume PDF' })));
    await p.close();
    return `${Math.round(((await ref.get()).data().docs.preparedAt.toMillis() - was) / 60000)} min newer, downloads`;
  });

  await step('retired pages still render: old application detail downloads, answers', async () => {
    const app = (await db.collection(`users/${ME}/applications`).limit(1).get()).docs[0];
    const p = await open(ctx, `/applications/${app.id}`);
    const f = okFile(await download(p, p.getByRole('button', { name: 'Download tailored resume' })));
    await p.close();
    return f + ' (Retry NOT clicked: it would auto-apply)';
  });

  await step('sign out from the user menu lands on login', async () => {
    const p = await open(ctx, '/home');
    await p.getByRole('button', { name: /nirupam\.gupta90|^N$/ }).first().click();
    await p.getByRole('button', { name: /sign out/i }).first().click();
    await until(() => /login/.test(p.url()), 6000, 'login url');
    await p.close();
  });
  await ctx.close();
}

// ---------- signed out ----------
{
  const ctx = await browser.newContext();
  await step('signed out: /home redirects to login; wrong password shows an error; forgot page renders', async () => {
    const p = await ctx.newPage(); watch(p, errors);
    await p.goto(BASE + '/home', { waitUntil: 'load' }); await p.waitForTimeout(2000);
    assert(/login/.test(p.url()), 'not redirected: ' + p.url());
    await p.locator('input[type=email]').fill('nobody-click-test@example.com');
    await p.locator('input[type=password]').fill('wrong-password-123');
    await p.getByRole('button', { name: /sign in|log in/i }).click();
    await p.waitForTimeout(3000);
    const text = await p.locator('#root').innerText();
    assert(/incorrect|invalid|wrong|not found|failed|try again|do not recognize/i.test(text), 'no error message shown: ' + text.replace(/\n+/g, ' | ').slice(0, 200));
    await p.getByRole('link', { name: /forgot/i }).click();
    await p.waitForTimeout(1500);
    assert(await p.locator('input[type=email]').isVisible(), 'forgot page has no email box');
    return 'reset email NOT sent';
  });
  await ctx.close();
}

// ---------- account 2, read-only ----------
{
  const ctx = await session(browser, HER);
  const pBefore = (await db.doc(`users/${HER}/profile/profile`).get()).data().updatedAt;
  await step('member2 (read-only): nav round trip with empty data', async () => {
    const p = await open(ctx, '/home');
    for (const label of ['Jobs', 'Applications', 'Resume', 'Profile', 'Assistant', 'Home']) {
      await p.locator('header, nav').getByRole('link', { name: label, exact: true }).first().click();
      await p.waitForTimeout(1200);
      assert((await p.locator('main h1, h1').first().innerText()).trim() === label, `h1 is not ${label}`);
    }
    await p.close();
  });
  await step('member2 (read-only): each version opens in compare view with publications, PDF downloads', async () => {
    const p = await open(ctx, '/resume');
    const rows = p.locator('main li, main div').filter({ has: p.getByRole('button', { name: 'Delete' }) }).filter({ hasText: /^(?!.*Versions)/ });
    const out = [];
    const n = await p.getByRole('button', { name: 'Delete' }).count();
    for (let i = 0; i < n; i++) {
      await p.getByRole('button', { name: 'Delete' }).nth(i).locator('xpath=ancestor::*[self::li or self::div][2]').click({ position: { x: 5, y: 5 } });
      await until(() => p.getByRole('button', { name: 'Download PDF' }).isVisible(), 8000, 'compare view');
      await p.waitForTimeout(800);
      const text = await p.locator('main').innerText();
      out.push(`v${i + 1}: ${okFile(await download(p, p.getByRole('button', { name: 'Download PDF' })))}, Publications editor ${/publications/i.test(text) ? 'yes' : 'NO'}, Research skills box ${/\bresearch\n/i.test(text) ? 'yes' : 'NO'}`);
    }
    await p.close();
    return out.join(' ;; ');
  });
  await step('member2 (read-only): profile renders her publications / awards / volunteer, nothing written', async () => {
    const p = await open(ctx, '/profile');
    const text = await p.locator('main').innerText();
    const tas = await p.locator('main textarea').evaluateAll((els) => els.map((e) => e.value.split('\n').filter(Boolean).length));
    await p.close();
    const after = (await db.doc(`users/${HER}/profile/profile`).get()).data().updatedAt;
    assert(after.isEqual(pBefore), 'her profile updatedAt changed!');
    assert(/publications/i.test(text) && /honours|awards/i.test(text) && /volunteer/i.test(text) && /laboratory/i.test(text), 'Publications or Laboratory field missing');
    return `line fields hold ${tas.join('/')} entries; updatedAt untouched`;
  });
  await ctx.close();
}

await browser.close();
console.log('\n==== SUMMARY ====\n' + results.join('\n'));
process.exit(0);
