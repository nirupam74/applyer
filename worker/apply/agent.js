import admin from 'firebase-admin';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { withBrowser, looksBlocked, sleep } from '../sources/browser.js';
import { emptyProfile } from '../resume/extract.js';
import { getAnswer } from './answers.js';
import { prepareDocuments } from './documents.js';
import { readVerificationCode } from './mail.js';

const FieldValue = admin.firestore.FieldValue;

const MAX_SCREENSHOTS = 6;
const MAX_SCREENSHOT_BYTES = 300 * 1024;
const MAX_STEPS = 12;

// ---- small page helpers -----------------------------------------------------

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// A CAPTCHA is never solved. A verification-code step is answered from the user's own
// mailbox (apply/mail.js); if no code arrives the step is reported as blocked.
async function detectPause(page, ctx) {
  const raw = await detectPauseRaw(page);
  if (!raw || !raw.startsWith('verification code')) return raw;
  const ok = await enterVerificationCode(page, ctx).catch((err) => { ctx.log && ctx.log(`mail: ${err.message}`); return false; });
  return ok ? null : `blocked: ${raw} and no code arrived by email`;
}

async function enterVerificationCode(page, ctx) {
  const input = await page.$('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[aria-label*="code" i], input[placeholder*="code" i]');
  if (!input) return false;
  await ctx.log?.('verification code requested, checking the mailbox');
  const host = hostOf(page.url()).replace(/^www\./, '').split('.')[0];
  const found = await readVerificationCode(page.context(), { query: `${host} code`, since: ctx.startedAt || Date.now() - 10 * 60e3, log: ctx.log || (async () => {}) })
    || await readVerificationCode(page.context(), { query: 'verification code', since: ctx.startedAt || Date.now() - 10 * 60e3, timeoutMs: 60e3, log: ctx.log || (async () => {}) });
  if (!found) return false;
  await input.fill(found.code);
  await ctx.log?.(`entered verification code from "${found.subject.slice(0, 60)}"`);
  await clickByText(page, page, ['Verify', 'Submit', 'Continue', 'Next', 'Confirm']).catch(() => {});
  await page.waitForTimeout(4000);
  return true;
}

async function detectPauseRaw(page) {
  // Only a VISIBLE challenge counts. Pages routinely load the reCAPTCHA script
  // (LinkedIn does) without ever showing a challenge; an invisible v3 badge is not a wall.
  try {
    const found = await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 40 && r.height > 40 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
      for (const f of document.querySelectorAll('iframe')) {
        const src = f.getAttribute('src') || '';
        if (/size=invisible/.test(src)) continue;
        if (/recaptcha\/api2\/(anchor|bframe)|recaptcha\/enterprise\/(anchor|bframe)/.test(src) && visible(f)) return 'recaptcha';
        if (/hcaptcha\.com/.test(src) && visible(f)) return 'hcaptcha';
        if (/challenges\.cloudflare\.com/.test(src) && visible(f)) return 'cloudflare turnstile';
        if (/arkoselabs|funcaptcha/.test(src) && visible(f)) return 'arkose';
      }
      for (const el of document.querySelectorAll('.cf-turnstile, .h-captcha, #challenge-running, #px-captcha')) if (visible(el)) return 'challenge widget';
      const text = (document.body?.innerText || '').toLowerCase();
      if (/verify you are human|i'm not a robot|prove you are human|press and hold/.test(text)) return 'challenge text';
      const codeHints = ["verification code","security code","enter the code","one-time passcode","6-digit code","confirm your identity"];
      const hit = codeHints.find((h) => text.includes(h));
      return hit ? 'code:' + hit : null;
    });
    if (!found) return null;
    if (found.startsWith('code:')) return `verification code required ('${found.slice(5)}')`;
    return `captcha detected (${found})`;
  } catch { return null; }
}

// Best-effort human label for a form control, ported from apply.py's label_for: aria-labelledby,
// label[for], aria-label/placeholder/name, then the nearest ancestor's text.

// Serialized into page.evaluate: finds the question text that owns a form control by walking
// up the ancestors and taking the first label-like element that does not contain the control.
const QUESTION_TEXT_SRC = `(node) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const looksLikeId = (t) => !t || t.length < 3 || t.length > 400 || /\\[|^[0-9a-f-]{16,}$|^field\\d*$/i.test(t);
  let anc = node.parentElement;
  for (let i = 0; i < 6 && anc && anc !== document.body; i++, anc = anc.parentElement) {
    for (const q of anc.querySelectorAll('legend, .application-label, [class*="question" i], [class*="label" i]:not(label), [class*="title" i], h1, h2, h3, h4, h5, h6, label')) {
      if (q.contains(node) || q.querySelector('input,select,textarea')) continue;
      const t = norm(q.innerText);
      if (!looksLikeId(t)) return t.slice(0, 200);
    }
  }
  return '';
}`;

async function labelFor(el) {
  return el.evaluate((node, QT) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const labelledby = node.getAttribute('aria-labelledby');
    if (labelledby) {
      const id = labelledby.split(/\s+/)[0];
      const le = document.getElementById(id);
      if (le) { const t = norm(le.innerText); if (t) return t; }
    }
    if (node.id) {
      const le = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (le) { const t = norm(le.innerText); if (t) return t; }
    }
    const parentLabel = node.closest('label');
    if (parentLabel) { const t = norm(parentLabel.innerText); if (t) return t; }
    for (const attr of ['aria-label', 'placeholder']) {
      const v = node.getAttribute(attr);
      if (v && v.length > 1) return norm(v);
    }
    const q = (new Function('return ' + QT)())(node);
    if (q) return q;
    const nm = node.getAttribute('name') || '';
    if (nm.length > 1 && !/\[|^[0-9a-f-]{16,}$/.test(nm)) return norm(nm);
    return ''; // unknown question: better a red gap than a guessed answer
  }, QUESTION_TEXT_SRC).catch(() => '');
}

async function isRequired(el) {
  return el.evaluate((node) => node.required === true || node.getAttribute('aria-required') === 'true').catch(() => false);
}

async function isUsable(el) {
  try {
    return (await el.isVisible()) && !(await el.isDisabled());
  } catch {
    return false;
  }
}

// ---- generic form filling (Workday, Greenhouse, Lever, SmartRecruiters, Taleo, iCIMS, ...) ----
// Ports apply.py's heuristics (text inputs, native selects, react-selects) and adds radio groups
// and standalone checkboxes, which apply.py never covered.

async function fillTextInputs(root, ctx, out) {
  const els = await root.$$('input[type=text], input[type=email], input[type=tel], input[type=url], input[type=number], input:not([type]), textarea');
  for (const el of els) {
    if (!(await isUsable(el))) continue;
    const role = await el.getAttribute('role').catch(() => null);
    if (role === 'combobox') continue; // handled by fillReactSelects, never both
    const current = await el.inputValue().catch(() => '');
    if (current.trim()) continue;
    const label = await labelFor(el);
    if (!label) continue;
    const { value, confidence } = await getAnswer(ctx, label);
    if (value) {
      if (value.length <= 80) { await el.click().catch(() => {}); await el.fill('').catch(() => {}); await el.type(value, { delay: 15 }).catch(() => el.fill(value).catch(() => {})); }
      else await el.fill(value).catch(() => {});
      el._lastTyped = value;
      await pickSuggestion(el);
      out.push({ name: label, value, confidence });
    } else if (await isRequired(el)) {
      out.push({ name: label, value: '', confidence: 'red' });
      ctx._requiredGap = true;
    }
  }
}

// Autocomplete inputs (Lever location, Greenhouse school, Workday typeahead) only validate
// once a suggestion is chosen; pick the first one that appears after typing.
async function pickSuggestion(el) {
  try {
    const frame = await el.ownerFrame();
    if (!frame) return;
    await new Promise((r) => setTimeout(r, 1500));
    const sel = '.dropdown-results > *, [role="listbox"] [role="option"], ul[class*="suggest" i] li, [class*="autocomplete" i] [class*="item" i], [class*="typeahead" i] li, .pac-item';
    let opt = frame.locator(sel).filter({ visible: true }).first();
    if (!(await opt.count().catch(() => 0))) {
      // Lookup services sometimes answer "no results" under load; retype once after a pause.
      const typed = await el.inputValue().catch(() => '');
      const noResults = await frame.locator('text=/no (location|results?) found/i').filter({ visible: true }).count().catch(() => 0);
      if (!typed && !noResults) return;
      await new Promise((r) => setTimeout(r, 6000));
      await el.click().catch(() => {}); await el.fill('').catch(() => {}); await el.type(typed || el._lastTyped || '', { delay: 40 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      opt = frame.locator(sel).filter({ visible: true }).first();
      if (!(await opt.count().catch(() => 0))) return;
    }
    await opt.click({ timeout: 3000 }); // a real pointer click: some widgets ignore synthetic clicks
    await new Promise((r) => setTimeout(r, 600));
  } catch {
    // no suggestion list: plain text input
  }
}

async function fillNativeSelects(root, ctx, out) {
  for (const sel of await root.$$('select')) {
    if (!(await isUsable(sel))) continue;
    const label = await labelFor(sel);
    if (!label) continue;
    const already = await sel.evaluate((s) => s.selectedIndex > 0 && !!s.value).catch(() => false);
    if (already) continue;
    const options = await sel.$$eval('option', (opts) => opts.map((o) => o.textContent.trim()).filter(Boolean));
    const { value, confidence } = await getAnswer(ctx, label, options);
    if (!value) {
      if (await isRequired(sel)) { out.push({ name: label, value: '', confidence: 'red' }); ctx._requiredGap = true; }
      continue;
    }
    const picked = await sel.selectOption({ label: value }).catch(() => null);
    if (picked) out.push({ name: label, value, confidence });
  }
}

async function fillReactSelects(page, root, ctx, out) {
  for (const cb of await root.$$('[role=combobox]')) {
    if (!(await isUsable(cb))) continue;
    const label = await labelFor(cb);
    if (!label) continue;
    const { value, confidence } = await getAnswer(ctx, label);
    if (!value) continue;
    try {
      await cb.click();
      await page.waitForTimeout(250);
      await cb.type(value, { delay: 25 });
      await page.waitForTimeout(650);
      const option = page.locator('[role="option"], .select__option, li[id*="option" i]').filter({ hasText: value }).first();
      let matched = false;
      if (await option.count().catch(() => 0)) {
        await option.click().catch(() => {});
        matched = true;
      } else {
        await page.keyboard.press('Enter').catch(() => {});
      }
      await page.waitForTimeout(250);
      out.push({ name: label, value, confidence: matched ? confidence : 'red' });
    } catch {
      out.push({ name: label, value: '', confidence: 'red' });
    }
  }
}

async function radioGroupLabel(el) {
  return el.evaluate((node, QT) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const fs = node.closest('fieldset');
    if (fs) { const leg = fs.querySelector('legend'); if (leg) return norm(leg.innerText); }
    const q = (new Function('return ' + QT)())(node);
    if (q) return q.slice(0, 200);
    const nm = node.getAttribute('name') || '';
    return /\[|^[0-9a-f-]{16,}$/.test(nm) ? '' : nm;
  }, QUESTION_TEXT_SRC).catch(() => '');
}

async function radioOwnLabel(el) {
  return el.evaluate((node) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    if (node.id) {
      const le = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (le) return norm(le.innerText);
    }
    const parentLabel = node.closest('label');
    if (parentLabel) return norm(parentLabel.innerText);
    const sib = node.nextElementSibling;
    if (sib) return norm(sib.innerText || sib.textContent);
    return '';
  }).catch(() => '');
}

async function fillRadioGroups(root, ctx, out) {
  const radios = await root.$$('input[type=radio]');
  const groups = new Map();
  for (const el of radios) {
    if (!(await isUsable(el))) continue;
    const name = await el.evaluate((n) => n.name || '').catch(() => '');
    const key = name || (await radioGroupLabel(el));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  }
  for (const [, els] of groups) {
    const anyChecked = await Promise.all(els.map((e) => e.isChecked().catch(() => false)));
    if (anyChecked.some(Boolean)) continue;
    const question = await radioGroupLabel(els[0]);
    if (!question) continue;
    const optionLabels = [];
    for (const e of els) optionLabels.push(await radioOwnLabel(e));
    let { value, confidence } = await getAnswer(ctx, question, optionLabels);
    if (!value && ACK_RE.test(question)) { // "I am aware that..." Yes/No: acknowledge, flag yellow
      value = optionLabels.find((l) => /^yes\b/i.test(l)) || null; confidence = 'yellow';
    }
    if (!value) {
      if (await isRequired(els[0])) { out.push({ name: question, value: '', confidence: 'red' }); ctx._requiredGap = true; }
      continue;
    }
    const idx = optionLabels.findIndex((l) => l === value);
    if (idx >= 0) {
      await els[idx].check().catch(() => {});
      out.push({ name: question, value, confidence });
    }
  }
}

const SKIP_CHECKBOX_RE = /terms|privacy|consent|agree|policy|acknowledge|i am aware|i understand|i confirm|i certify|i accept/i;
const ACK_RE = /i am aware|acknowledge|i understand|i confirm|i certify/i;

async function fillCheckboxes(root, ctx, out) {
  const all = await root.$$('input[type=checkbox]');
  const byName = new Map();
  for (const el of all) { const n = await el.evaluate((x) => x.name || '').catch(() => ''); if (n) byName.set(n, (byName.get(n) || 0) + 1); }
  const groupsDone = new Set();
  for (const el of all) {
    if (!(await isUsable(el))) continue;
    const name = await el.evaluate((x) => x.name || '').catch(() => '');
    if (name && byName.get(name) > 1) { // several boxes under one question: choose one, like a radio group
      if (groupsDone.has(name)) continue;
      groupsDone.add(name);
      const els = []; for (const e of all) if ((await e.evaluate((x) => x.name || '').catch(() => '')) === name) els.push(e);
      if ((await Promise.all(els.map((e) => e.isChecked().catch(() => false)))).some(Boolean)) continue;
      const question = await radioGroupLabel(els[0]);
      const optionLabels = []; for (const e of els) optionLabels.push(await radioOwnLabel(e));
      const { value, confidence } = await getAnswer(ctx, question || name, optionLabels);
      const idx = optionLabels.findIndex((l) => l === value);
      if (idx >= 0) { await els[idx].check().catch(() => {}); out.push({ name: question || name, value, confidence }); }
      else if (await isRequired(els[0])) { out.push({ name: question || name, value: '', confidence: 'red' }); ctx._requiredGap = true; }
      continue;
    }
    if (await el.isChecked().catch(() => false)) continue;
    const own = await labelFor(el);
    if (!own) continue;
    const question = await radioGroupLabel(el);
    const label = question && question !== own && !own.includes(question) ? `${question} -> ${own}` : own;
    if (SKIP_CHECKBOX_RE.test(label)) { // consent/terms: the user chose fully autonomous submission
      await el.check().catch(() => {});
      out.push({ name: label, value: 'Yes', confidence: 'yellow' });
      continue;
    }
    const { value, confidence } = await getAnswer(ctx, label, ['Yes', 'No']);
    if (value === 'Yes') {
      await el.check().catch(() => {});
      out.push({ name: label, value: 'Yes', confidence });
    } else if (!value && (await isRequired(el))) {
      out.push({ name: label, value: '', confidence: 'red' });
      ctx._requiredGap = true;
    }
  }
}

async function uploadFiles(root, docs, out) {
  const inputs = await root.$$('input[type=file]');
  const files = [docs.resumePath, docs.coverPath].filter(Boolean);
  for (let i = 0; i < inputs.length && i < files.length; i++) {
    try {
      await inputs[i].setInputFiles(files[i]);
      out.push({ name: i === 0 ? 'resume upload' : 'cover letter upload', value: path.basename(files[i]), confidence: 'green' });
    } catch {
      out.push({ name: 'file upload', value: '', confidence: 'red' });
    }
  }
}

// One fill pass over whatever is visible right now. Returns the fields it touched.
async function fillGenericForm(page, root, ctx, docs) {
  const out = [];
  await fillTextInputs(root, ctx, out);
  await fillNativeSelects(root, ctx, out);
  await fillReactSelects(page, root, ctx, out);
  await fillRadioGroups(root, ctx, out);
  await fillCheckboxes(root, ctx, out);
  if (docs) await uploadFiles(root, docs, out);
  return out;
}

// Locates a visible button without clicking it.
async function findByText(root, texts) {
  for (const t of texts) {
    const btn = root.locator(`button:has-text("${t}"), input[type=submit][value*="${t}" i], a:has-text("${t}")`).first();
    if ((await btn.count().catch(() => 0)) && (await btn.isVisible().catch(() => false))) return btn;
  }
  return null;
}

// Required controls the browser itself would refuse to submit, with their question text.
async function invalidRequired(page) {
  return page.evaluate((QT) => {
    const qt = new Function('return ' + QT)();
    const out = [];
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!el.required || el.disabled) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0 && el.type !== 'file') continue;
      if (typeof el.checkValidity === 'function' && el.checkValidity()) continue;
      const label = document.querySelector(`label[for="${CSS.escape(el.id || '')}"]`);
      out.push((label && label.innerText.trim()) || qt(el) || el.name || el.type);
    }
    return [...new Set(out)];
  }, QUESTION_TEXT_SRC).catch(() => []);
}

// Presses submit and returns { ok, confirmation }. Success means a confirmation message,
// or the form is gone and nothing is invalid, or the URL moved on with no form left.
async function submitAndVerify(page, btn) {
  const before = { url: page.url(), inputs: await page.locator('form input, form textarea, form select').count().catch(() => 0) };
  await btn.click().catch(() => {});
  await page.waitForTimeout(3000);
  const confirmation = await captureConfirmation(page);
  if (confirmation) return { ok: true, confirmation };
  const invalid = await invalidRequired(page);
  const inputs = await page.locator('form input, form textarea, form select').count().catch(() => 0);
  const urlChanged = page.url() !== before.url;
  if (invalid.length) return { ok: false, confirmation: null, reason: `submit rejected, required field(s) still empty: ${invalid.slice(0, 4).join(' | ')}` };
  if (inputs === 0 || (urlChanged && inputs < before.inputs / 2)) return { ok: true, confirmation: null };
  return { ok: false, confirmation: null, reason: 'submit did not go through (form still on screen, no confirmation)' };
}

async function clickByText(page, root, texts) {
  for (const t of texts) {
    const btn = root.locator(`button:has-text("${t}"), input[type=submit][value*="${t}" i], a:has-text("${t}")`).first();
    if (await btn.count().catch(() => 0)) {
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        return t;
      }
    }
  }
  return null;
}

// ---- Workday account creation ----------------------------------------------

function genPassword(len = 20) {
  return crypto.randomBytes(len).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, len) + '!9Aa';
}

async function ensureWorkdayAccount(page, root, ctx, host, appEmail) {
  const createLink = root.locator('text=/create account/i').first();
  if (await createLink.count().catch(() => 0)) {
    if (await createLink.isVisible().catch(() => false)) {
      await createLink.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }
  const pwFields = await root.$$('input[type=password]');
  if (!pwFields.length) return null; // no account step on this page

  const userRef = ctx.db.collection('users').doc(ctx.uid);
  const portalsRef = userRef.collection('settings').doc('portals');
  const portalsSnap = await portalsRef.get();
  const portals = (portalsSnap.exists && portalsSnap.data()) || {};
  let creds = portals[host];
  if (!creds) {
    creds = { email: appEmail, password: genPassword(20), createdAt: new Date().toISOString() };
    await portalsRef.set({ [host]: creds }, { merge: true });
  }

  const emailField = (await root.$$('input[type=email]'))[0];
  if (emailField) await emailField.fill(creds.email).catch(() => {});
  for (const f of pwFields) await f.fill(creds.password).catch(() => {});
  await clickByText(page, root, ['Create Account', 'Sign Up', 'Continue']);
  await page.waitForTimeout(1200);
  return { name: 'workday account', value: creds.email, confidence: 'green' };
}

// ---- confirmation / screenshots ---------------------------------------------

async function captureConfirmation(page) {
  const deadline = Date.now() + 15000;
  let text = '';
  while (Date.now() < deadline) {
    text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/thank you|application (submitted|received|complete)|successfully applied|we('| ha)ve received your application/i.test(text)) break;
    await sleep(1000);
  }
  const m = text.match(/[^.\n]*\b(thank you|application (submitted|received)|successfully applied)[^.\n]*[.\n]?/i);
  return m ? m[0].trim().slice(0, 300) : null;
}

async function takeShot(page, appRef, screenshots) {
  if (screenshots.length >= MAX_SCREENSHOTS) return;
  try {
    const buf = await page.screenshot({ type: 'png' }); // viewport only, never full page
    // ponytail: oversize screenshots are dropped rather than recompressed; upgrade to jpeg fallback if this bites
    if (buf.length > MAX_SCREENSHOT_BYTES) return;
    screenshots.push(buf);
    await appRef.update({ screenshots: FieldValue.arrayUnion(buf) }).catch(() => {});
  } catch {
    // best effort only
  }
}

// ---- application doc plumbing ------------------------------------------------

async function recordFields(appRef, fields) {
  if (!fields.length) return;
  await appRef.update({ 'review.fields': FieldValue.arrayUnion(...fields) }).catch(() => {});
}

function pickApplyUrl(job) {
  const sources = job.sources || [];
  const linkedinSrc = sources.find((s) => s.name === 'linkedin');
  const src = linkedinSrc || sources[0];
  return (src && (src.applyUrl || src.url)) || job.applyUrl || job.url;
}

// Reuse a previous attempt's documents for this job when they still exist on disk, so a retry
// doesn't pay for another 60-90s LLM tailoring + cover-letter pass.
async function findCachedDocs(userRef, jobId) {
  const snap = await userRef.collection('applications')
    .where('jobId', '==', jobId)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (!d.resumeVersionId || !d.coverLetterId || !d.resumePath || !d.coverPath) continue;
    try {
      await fsp.access(d.resumePath);
      await fsp.access(d.coverPath);
      return { resumeVersionId: d.resumeVersionId, coverLetterId: d.coverLetterId, resumePath: d.resumePath, coverPath: d.coverPath, email: d.email };
    } catch {
      // file gone, keep looking
    }
  }
  return null;
}

// ---- site handlers ------------------------------------------------------------

async function handleLinkedIn(page, ctx, docs, appRef, screenshots, allFields) {
  const easyApply = page.locator('button:has-text("Easy Apply")').first();
  if (!(await easyApply.count().catch(() => 0)) || !(await easyApply.isVisible().catch(() => false))) {
    // External apply: follow the link, then fall through to the generic ATS filler.
    const applyBtn = page.locator('button:has-text("Apply"), a:has-text("Apply")').first();
    if (await applyBtn.count().catch(() => 0)) {
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 8000 }).catch(() => null),
        applyBtn.click().catch(() => {}),
      ]);
      const target = popup || page;
      await target.waitForLoadState('domcontentloaded').catch(() => {});
      return handleGeneric(target, ctx, docs, appRef, screenshots, allFields);
    }
    return { status: 'blocked', error: 'no Easy Apply or Apply button found' };
  }

  await easyApply.click().catch(() => {});
  await page.waitForTimeout(1200);
  const modal = page.locator('.jobs-easy-apply-modal, [role="dialog"]').first();
  const root = (await modal.count().catch(() => 0)) ? modal : page;

  for (let step = 0; step < MAX_STEPS; step++) {
    const pause = await detectPause(page, ctx);
    if (pause) return { status: 'blocked', error: pause };

    // Uncheck "follow company" if present.
    const follow = root.locator('label:has-text("Follow"), text=/follow .* company/i').first();
    if (await follow.count().catch(() => 0)) {
      const box = root.locator('input[type=checkbox]').first();
      if ((await box.count().catch(() => 0)) && (await box.isChecked().catch(() => false))) {
        await box.uncheck().catch(() => {});
      }
    }

    const fields = await fillGenericForm(page, root, ctx, docs);
    allFields.push(...fields);
    await recordFields(appRef, fields);
    await takeShot(page, appRef, screenshots);

    const submitBtn = await findByText(root, ['Submit application', 'Submit Application']);
    if (submitBtn) {
      const invalid = await invalidRequired(page);
      if (invalid.length) {
        const gaps = invalid.map((name) => ({ name, value: '', confidence: 'red' }));
        allFields.push(...gaps); await recordFields(appRef, gaps);
        return { status: 'blocked', error: `required field(s) left empty: ${invalid.slice(0, 4).join(' | ')}` };
      }
      if (ctx._requiredGap) return { status: 'blocked', error: 'required field(s) left empty' };
      if (!ctx.autoSubmit) return { status: 'ready', portalUrl: page.url() };
      const result = await submitAndVerify(page, submitBtn);
      await takeShot(page, appRef, screenshots);
      if (!result.ok) return { status: 'blocked', error: result.reason, portalUrl: page.url() };
      return { status: 'submitted', confirmation: result.confirmation, portalUrl: page.url() };
    }
    const nextTxt = await clickByText(page, root, ['Review', 'Next']);
    if (!nextTxt) return { status: 'blocked', error: 'no Next/Review/Submit control found in Easy Apply modal' };
    await page.waitForTimeout(1000);
  }
  return { status: 'blocked', error: 'Easy Apply modal exceeded max steps' };
}

async function handleZipRecruiter(page, ctx, docs, appRef, screenshots, allFields) {
  const oneClick = page.locator('button:has-text("1-Click Apply"), button:has-text("Quick Apply"), button:has-text("Apply Now"), button:has-text("Apply")').first();
  if (!(await oneClick.count().catch(() => 0))) {
    return { status: 'blocked', error: 'no Apply button found on the ZipRecruiter listing' };
  }
  const before = page.url();
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 6000 }).catch(() => null),
    oneClick.click().catch(() => {}),
  ]);
  await page.waitForTimeout(1200);
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    return handleGeneric(popup, ctx, docs, appRef, screenshots, allFields);
  }
  if (page.url() !== before) {
    // Either a ZipRecruiter-hosted form (still on ziprecruiter.com) or an external ATS.
    return handleGeneric(page, ctx, docs, appRef, screenshots, allFields);
  }
  return { status: 'blocked', error: 'Apply click did not open a form or a new tab' };
}

// Some ATS hide the form until "Apply" is clicked (apply.py's lesson), and some career sites
// (Loblaw included) open the real form in a new tab when that button is clicked. Do this once,
// before looking for Next/Submit controls, so the loop below isn't just staring at a job posting.
async function revealApplyForm(page) {
  for (const t of ['Apply Now', 'Apply for this job', 'Apply for this position', 'Apply']) {
    const btn = page.locator(`button:has-text("${t}"), a:has-text("${t}")`).first();
    if (await btn.count().catch(() => 0)) {
      if (await btn.isVisible().catch(() => false)) {
        const [popup] = await Promise.all([
          page.waitForEvent('popup', { timeout: 4000 }).catch(() => null),
          btn.click().catch(() => {}),
        ]);
        await page.waitForTimeout(1000);
        if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => {});
        return popup;
      }
    }
  }
  return null;
}

// Waits for the network to go quiet and for at least one form control or button to be visible (up to ~20 s).
async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.locator('input:visible, select:visible, textarea:visible, button:visible, a[href]:visible').first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

// Job boards sometimes redirect an Apply click to an unrelated sponsored posting. The page
// must name the employer or most of the title before a single field is touched.
async function landedOnDifferentPosting(page, job) {
  const text = (await page.evaluate(() => (document.title + ' ' + (document.body?.innerText || '').slice(0, 6000)).toLowerCase()).catch(() => '')) || '';
  if (!text.trim()) return null; // nothing rendered yet; later checks will report no controls
  const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const companyToks = squash(job.company).split(' ').filter((w) => w.length > 2 && !/^(inc|ltd|llc|the|group|corp|company|canada)$/.test(w));
  const titleToks = squash(job.title).split(' ').filter((w) => w.length > 2 && !/^(and|the|for|intern|internship|co|op)$/.test(w));
  const companyHit = companyToks.length > 0 && companyToks.some((w) => text.includes(w));
  const titleHits = titleToks.filter((w) => text.includes(w)).length;
  if (companyHit || (titleToks.length && titleHits >= Math.ceil(titleToks.length * 0.6))) return null;
  const h1 = (await page.locator('h1').first().innerText().catch(() => '')) || (await page.title().catch(() => ''));
  return (h1 || 'unknown page').trim().slice(0, 120);
}

async function handleGeneric(page, ctx, docs, appRef, screenshots, allFields) {
  const popup = await revealApplyForm(page);
  if (popup) page = popup; // reassigning the parameter: every use below now targets the new tab
  const host = hostOf(page.url());
  for (let step = 0; step < MAX_STEPS; step++) {
    await settle(page); // single-page ATSs render well after load; never scan a blank shell
    if (step === 0) {
      const wrong = await landedOnDifferentPosting(page, ctx.job);
      if (wrong) return { status: 'blocked', error: `landed on a different posting: ${wrong}`, portalUrl: page.url() };
    }
    const pause = await detectPause(page, ctx);
    if (pause) return { status: 'blocked', error: pause };

    if (/workday/i.test(host)) {
      const acct = await ensureWorkdayAccount(page, page, ctx, host, docs.email);
      if (acct) { allFields.push(acct); await recordFields(appRef, [acct]); }
      const pause2 = await detectPause(page, ctx);
      if (pause2) return { status: 'blocked', error: `blocked: verification code (${pause2})` };
    }

    const fields = await fillGenericForm(page, page, ctx, docs);
    allFields.push(...fields);
    await recordFields(appRef, fields);
    await takeShot(page, appRef, screenshots);

    const submitBtn = await findByText(page, ['Submit Application', 'Submit application', 'Submit', 'Send Application']);
    if (submitBtn) {
      const invalid = await invalidRequired(page);
      if (invalid.length) {
        const gaps = invalid.map((name) => ({ name, value: '', confidence: 'red' }));
        allFields.push(...gaps); await recordFields(appRef, gaps);
        return { status: 'blocked', error: `required field(s) left empty: ${invalid.slice(0, 4).join(' | ')}` };
      }
      if (ctx._requiredGap) return { status: 'blocked', error: 'required field(s) left empty' };
      if (!ctx.autoSubmit) return { status: 'ready', portalUrl: page.url() };
      const result = await submitAndVerify(page, submitBtn);
      await takeShot(page, appRef, screenshots);
      if (!result.ok) return { status: 'blocked', error: result.reason, portalUrl: page.url() };
      return { status: 'submitted', confirmation: result.confirmation, portalUrl: page.url() };
    }
    const nextTxt = await clickByText(page, page, ['Next', 'Continue', 'Save and Continue', 'Save & Continue']);
    if (!nextTxt) return { status: 'blocked', error: 'no Next/Submit control found; may need manual completion', portalUrl: page.url() };
    await page.waitForTimeout(1200);
  }
  return { status: 'blocked', error: 'form exceeded max steps', portalUrl: page.url() };
}

// ---- entry points -------------------------------------------------------------

// applyToJob({ db, uid, log }, { jobId, autoSubmit?, resumePath?, coverPath?, resumeVersionId?, coverLetterId?, email? })
// The optional overrides after jobId exist for testing (dry runs, doc stubbing) without touching
// the user's stored settings.
export async function applyToJob({ db, uid, log }, payload) {
  const { jobId } = payload;
  if (!jobId) throw new Error('applyToJob requires payload.jobId');

  const userRef = db.collection('users').doc(uid);
  const appRef = userRef.collection('applications').doc();
  await appRef.set({ jobId, status: 'preparing', log: [], review: { fields: [] }, screenshots: [], createdAt: FieldValue.serverTimestamp() });

  const appendLog = async (msg) => {
    await log(msg);
    await appRef.update({ log: FieldValue.arrayUnion(`${new Date().toISOString()} ${msg}`) }).catch(() => {});
  };

  try {
    const jobSnap = await userRef.collection('jobs').doc(jobId).get();
    if (!jobSnap.exists) throw new Error(`job ${jobId} not found`);
    const job = jobSnap.data();

    const profileSnap = await userRef.collection('profile').doc('profile').get();
    const profile = profileSnap.exists ? profileSnap.data() : emptyProfile();

    const settingsSnap = await userRef.collection('settings').doc('applications').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const autoSubmit = typeof payload.autoSubmit === 'boolean' ? payload.autoSubmit : !!settings.autoSubmit;

    let docs;
    if (payload.resumePath && payload.coverPath) {
      docs = {
        resumeVersionId: payload.resumeVersionId || null,
        coverLetterId: payload.coverLetterId || null,
        resumePath: payload.resumePath,
        coverPath: payload.coverPath,
        email: payload.email || settings.email || (profile.personal && profile.personal.email) || '',
      };
      await appendLog('using provided document paths (override)');
    } else {
      docs = await findCachedDocs(userRef, jobId);
      if (docs) {
        await appendLog('reusing documents from a previous attempt on this job');
      } else {
        await appendLog('preparing tailored resume and cover letter');
        docs = await prepareDocuments({ db, uid, log: appendLog }, { jobId });
      }
    }

    await appRef.update({
      status: 'filling',
      resumeVersionId: docs.resumeVersionId,
      coverLetterId: docs.coverLetterId,
      resumePath: docs.resumePath,
      coverPath: docs.coverPath,
      email: docs.email,
    });

    const applyUrl = pickApplyUrl(job);
    if (!applyUrl) throw new Error('job has no apply URL');

    const ctx = { db, uid, profile, settings, job, autoSubmit, log: appendLog, startedAt: Date.now(), _requiredGap: false };
    const screenshots = [];
    const allFields = [];

    const outcome = await withBrowser(async (context) => {
      const page = await context.newPage();
      const res = await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const status = res ? res.status() : 0;
      const html = await page.content().catch(() => '');
      if (status >= 400) return { status: 'blocked', error: `HTTP ${status} loading apply page` };
      if (looksBlocked({ url: page.url(), title: await page.title().catch(() => ''), html })) {
        return { status: 'blocked', error: `challenge or login wall at ${page.url()}` };
      }
      await appRef.update({ portalUrl: page.url() }).catch(() => {});
      await takeShot(page, appRef, screenshots);

      const host = hostOf(page.url());
      if (host.includes('linkedin.com')) return handleLinkedIn(page, ctx, docs, appRef, screenshots, allFields);
      if (host.includes('ziprecruiter.com')) return handleZipRecruiter(page, ctx, docs, appRef, screenshots, allFields);
      return handleGeneric(page, ctx, docs, appRef, screenshots, allFields);
    });

    if (outcome.status === 'submitted') {
      await appRef.update({
        status: 'submitted',
        submittedAt: FieldValue.serverTimestamp(),
        confirmation: outcome.confirmation || null,
        portalUrl: outcome.portalUrl || null,
      });
      await appendLog('submitted');
    } else if (outcome.status === 'ready') {
      await appRef.update({ status: 'blocked', error: 'autoSubmit is off; form filled and ready for manual review', portalUrl: outcome.portalUrl || null });
      await appendLog('ready to submit (autoSubmit off, not pressing submit)');
    } else {
      await appRef.update({ status: 'blocked', error: outcome.error || 'blocked', portalUrl: outcome.portalUrl || null });
      await appendLog(`blocked: ${outcome.error || 'unknown reason'}`);
    }

    return { applicationId: appRef.id, status: outcome.status === 'submitted' ? 'submitted' : 'blocked', confirmation: outcome.confirmation || null };
  } catch (err) {
    await appRef.update({ status: 'failed', error: err.message }).catch(() => {});
    await appendLog(`failed: ${err.message}`).catch(() => {});
    return { applicationId: appRef.id, status: 'failed', confirmation: null };
  }
}

// applyBatch({ db, uid, log }, { jobIds?, limit? })
export async function applyBatch({ db, uid, log }, payload = {}) {
  const userRef = db.collection('users').doc(uid);
  const limit = payload.limit || 20;

  let jobIds = payload.jobIds;
  if (!jobIds || !jobIds.length) {
    const snap = await userRef.collection('jobs').where('status', '==', 'saved').orderBy('rank', 'asc').limit(limit).get();
    jobIds = snap.docs.map((d) => d.id);
  } else {
    jobIds = jobIds.slice(0, limit);
  }

  const results = [];
  for (const jobId of jobIds) {
    const already = await userRef.collection('applications').where('jobId', '==', jobId).where('status', '==', 'submitted').limit(1).get();
    if (!already.empty) {
      await log(`${jobId}: already submitted, skipping`);
      results.push({ jobId, status: 'skipped' });
      continue;
    }
    try {
      await log(`${jobId}: applying`);
      const res = await applyToJob({ db, uid, log }, { jobId });
      results.push({ jobId, ...res });
      if (res.status === 'submitted') {
        await userRef.collection('jobs').doc(jobId).update({ status: 'applied', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
      }
      await log(`${jobId}: ${res.status}`);
    } catch (err) {
      results.push({ jobId, status: 'failed', error: err.message });
      await log(`${jobId}: failed - ${err.message}`);
    }
  }

  return {
    total: jobIds.length,
    submitted: results.filter((r) => r.status === 'submitted').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  };
}
