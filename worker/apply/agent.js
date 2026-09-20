import admin from 'firebase-admin';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { withBrowser, looksBlocked, sleep } from '../sources/browser.js';
import { emptyProfile } from '../resume/extract.js';
import { dedupKey } from '../rank.js';
import { getAnswer } from './answers.js';
import { prepareDocuments, resolveApplicationEmail } from './documents.js';
import { readVerificationCode } from './mail.js';

const FieldValue = admin.firestore.FieldValue;

const MAX_SCREENSHOTS = 6;
const MAX_SCREENSHOT_BYTES = 300 * 1024;
const MAX_STEPS = 12;
export const MIN_APPLY_SCORE = 80; // never apply below this match score
const HUMAN_WAIT_MS = 10 * 60e3;

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

const SUBMIT_TEXTS = ['Submit Application', 'Submit application', 'Submit', 'Send Application'];
const NEXT_TEXTS = ['Next', 'Continue', 'Save and Continue', 'Save & Continue'];
const isCaptcha = (pause) => /^captcha detected/.test(pause || '');

// CAPTCHA handoff. The agent never solves or dodges a challenge. Headless runs report
// needs_human; when the user asks for a visible run (payload.headed) the window comes to the
// front, a notification goes out, and the agent waits for the user to solve it themselves.
function notify(message) {
  if (process.env.NODE_TEST_CONTEXT) return; // set by node --test
  execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Applyer" sound name "Ping"`], () => {});
}

export async function waitForHuman(page, ctx, pause) {
  if (!ctx.headed || !isCaptcha(pause)) return pause;
  await ctx.log?.(`${pause}: waiting up to 10 min for you to solve it in the open window`);
  notify(`Solve the CAPTCHA for ${ctx.job.title} at ${ctx.job.company} in the open browser window.`);
  await page.bringToFront().catch(() => {});
  for (const end = Date.now() + HUMAN_WAIT_MS; Date.now() < end; ) {
    await page.waitForTimeout(3000);
    if (page.isClosed()) return 'the window was closed before the CAPTCHA was solved';
    pause = await detectPauseRaw(page);
    if (!isCaptcha(pause)) { await ctx.log?.('CAPTCHA solved by the user, continuing'); return detectPause(page, ctx); }
  }
  return `${pause}: nobody solved it within 10 minutes`;
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

export async function detectPauseRaw(page) {
  // Only a VISIBLE challenge counts. Pages routinely load the reCAPTCHA script
  // (LinkedIn does) without ever showing a challenge; an invisible v3 badge is not a wall.
  try {
    const found = await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 40 && r.height > 40 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
      // A solved checkbox stays on screen; the response token is what says it is done.
      const solved = [...document.querySelectorAll('[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]')].some((t) => (t.value || '').length > 20);
      for (const f of solved ? [] : document.querySelectorAll('iframe')) {
        const src = f.getAttribute('src') || '';
        if (/size=invisible/.test(src)) continue;
        if (/recaptcha\/api2\/(anchor|bframe)|recaptcha\/enterprise\/(anchor|bframe)/.test(src) && visible(f)) return 'recaptcha';
        if (/hcaptcha\.com/.test(src) && visible(f)) return 'hcaptcha';
        if (/challenges\.cloudflare\.com/.test(src) && visible(f)) return 'cloudflare turnstile';
        if (/arkoselabs|funcaptcha/.test(src) && visible(f)) return 'arkose';
      }
      for (const el of solved ? [] : document.querySelectorAll('.cf-turnstile, .h-captcha, #challenge-running, #px-captcha')) if (visible(el)) return 'challenge widget';
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

// Every filler goes through isUsable, so this is where page furniture is excluded: site search,
// job-alert / newsletter sign-ups, and anything in nav/header/footer/sidebar regions. Bare
// "search" is only matched on the form, never the input: Workday typeaheads are placeholder "Search".
// ponytail: heuristic exclusion list; scope fills to the detected application <form> if it leaks.
export function isPageFurniture(node) {
  if (node.type === 'search' || node.closest('nav, header, footer, aside, [role=search], [role=navigation], [role=complementary], [role=banner], [role=contentinfo]')) return true;
  const attrs = (n, names) => names.map((a) => n.getAttribute(a) || '').join(' ');
  const own = attrs(node, ['name', 'id', 'placeholder', 'aria-label']) + ' ' + [...(node.labels || [])].map((l) => l.innerText).join(' ');
  if (/alert|subscribe|newsletter|notify|talent (community|network)/i.test(own)) return true;
  const form = node.closest('form');
  return !!form && /search|alert|subscribe|newsletter|notify/i.test(attrs(form, ['id', 'class', 'name', 'action', 'aria-label']));
}

async function isUsable(el) {
  try {
    if (await el.evaluate(isPageFurniture)) return false;
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
    // Workday multi-select (country phone code): its search box is always empty, the choice sits
    // beside it as a pill. Typing again every round re-opened the list over the phone field.
    if (await el.evaluate((e) => !!e.closest('[data-automation-id="multiSelectContainer"]')?.querySelector('[data-automation-id="selectedItem"]')).catch(() => false)) continue;
    const label = await labelFor(el);
    if (!label) continue;
    const { value, confidence } = await getAnswer(ctx, label);
    // "none" / "N/A" is an answer for a box that must not stay empty. In an optional one (Middle
    // Name, Phone Extension) it is junk, and Workday validates the extension as part of the phone.
    if (value && /^(none|n\/?a|nil)\.?$/i.test(value.trim()) && !(await isRequired(el))) continue;
    if (value) {
      if (value.length <= 80) { await el.click().catch(() => {}); await el.fill('').catch(() => {}); await el.type(value, { delay: 15 }).catch(() => el.fill(value).catch(() => {})); }
      else await el.fill(value).catch(() => {});
      el._lastTyped = value;
      await pickSuggestion(el);
      out.push({ name: label, value: await acceptedPhone(el, label, value), confidence });
    } else if (await isRequired(el)) {
      out.push({ name: label, value: '', confidence: 'red' });
      ctx._requiredGap = true;
    }
  }
}

// "+1 (647) 642-3609" -> "6476423609"
export const nationalDigits = (phone) => String(phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// Forms with their own country-code control (Phenom: Manulife, RBC) reject "+1 (647) ..." and
// want the national number. The field says so itself: leave it and read aria-invalid. A field
// left invalid is never refilled (it is not empty), so Next failed for all twelve rounds.
async function acceptedPhone(el, label, value) {
  if (!/phone|mobile|\btel/i.test(label) || nationalDigits(value).length < 10) return value;
  await el.evaluate((e) => e.blur()).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  // Workday only complains after Next, but it labels its country-code box.
  const ownCodeBox = await el.evaluate((e) => /phone code/i.test((e.closest('form') || document.body).innerText)).catch(() => false);
  if (!ownCodeBox && (await el.getAttribute('aria-invalid').catch(() => null)) !== 'true') return value;
  const digits = nationalDigits(value);
  await el.fill(digits).catch(() => {});
  await el.evaluate((e) => e.blur()).catch(() => {});
  return digits;
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
    // Lookup services (Lever's location field) answer "No location found" under load and clear
    // the input. Retype with a longer pause each time. A field that kept its value and shows no
    // error is a plain text input: leave it alone.
    for (const pause of [6000, 12000]) {
      if (await opt.count().catch(() => 0)) break;
      const typed = await el.inputValue().catch(() => '');
      const noResults = await frame.locator('text=/no (location|results?) found/i').filter({ visible: true }).count().catch(() => 0);
      if (typed && !noResults) {
        await new Promise((r) => setTimeout(r, 1500)); // slow suggestion lists get one more look
        if (await opt.count().catch(() => 0)) break;
        return;
      }
      await new Promise((r) => setTimeout(r, pause));
      await el.click().catch(() => {}); await el.fill('').catch(() => {}); await el.type(el._lastTyped || typed, { delay: 60 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      opt = frame.locator(sel).filter({ visible: true }).first();
    }
    if (!(await opt.count().catch(() => 0))) return;
    await opt.click({ timeout: 3000 }); // a real pointer click: some widgets ignore synthetic clicks
    await new Promise((r) => setTimeout(r, 600));
  } catch {
    // no suggestion list: plain text input
  }
}

// Workday dropdowns: a button that opens a listbox ("Select One"). Open it, read the options,
// pick the answer by its exact text.
async function fillListboxButtons(page, root, ctx, out) {
  for (const btn of await root.$$('button[aria-haspopup="listbox"]')) {
    if (!(await isUsable(btn))) continue;
    const shown = (await btn.innerText().catch(() => '')).trim();
    if (shown && !/^select( one)?$/i.test(shown)) continue; // already chosen
    const label = (await labelFor(btn)).replace(/\s*select one.*$/i, '').trim();
    if (!label) continue;
    try {
      await btn.click();
      const opts = page.locator('[role="listbox"] [role="option"]').filter({ visible: true });
      await opts.first().waitFor({ state: 'visible', timeout: 4000 });
      const options = (await opts.allInnerTexts()).map((t) => t.trim()).filter((t) => t && !/^select one$/i.test(t));
      const { value, confidence } = await getAnswer(ctx, label, options);
      if (value) {
        await opts.getByText(value, { exact: true }).first().click();
        out.push({ name: label, value, confidence });
      } else {
        await page.keyboard.press('Escape').catch(() => {});
        out.push({ name: label, value: '', confidence: 'red' });
        if (/\*|required/i.test(label + (await btn.getAttribute('aria-label').catch(() => '')))) ctx._requiredGap = true;
      }
      await page.waitForTimeout(300);
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
    }
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
  if (!inputs.length) return;
  await docs.ready();
  const files =[docs.resumePath, docs.coverPath].filter(Boolean);
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
  await fillListboxButtons(page, root, ctx, out);
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

const stepSignature = (page) => page.evaluate(() => `${location.href}|${[...document.querySelectorAll('h1, h2, h3, legend')].filter((h) => h.offsetParent).map((h) => h.innerText.trim()).join('|').slice(0, 400)}`).catch(() => page.url());

const visibleErrors = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('[role=alert], [class*="error" i], [id*="error" i]')].filter((e) => e.offsetParent && !e.querySelector('input, select, textarea')).flatMap((e) => e.innerText.split('\n')).map((t) => t.trim()).filter((t) => t && t.length < 160))].slice(0, 4).join(' / ')).catch(() => '');

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

// Every place this job was found, LinkedIn first. A board that redirects to an unrelated
// posting (ZipRecruiter 1-Click, LinkedIn links to a generic careers page) is skipped for the next.
export function applyUrls(job) {
  const sources = [...(job.sources || [])].sort((a, b) => (b.name === 'linkedin') - (a.name === 'linkedin'));
  return [...new Set([...sources.map((s) => s.applyUrl || s.url), job.applyUrl, job.url].filter(Boolean))];
}

// Documents are made on first use. Most blocks (wrong posting, no Apply button, CAPTCHA wall)
// happen before any upload, and tailoring costs minutes of LLM time per job.
export function lazyDocs(email, load) {
  let pending;
  const docs = { email, ready: () => (pending ||= load().then((made) => Object.assign(docs, made))) };
  return docs;
}

// Reuse a previous attempt's documents for this job when they still exist on disk, so a retry
// doesn't pay for another 60-90s LLM tailoring + cover-letter pass.
// Documents tailored before the profile last changed are stale (a corrected graduation date must
// not keep going out on an old resume), so only attempts newer than profile.updatedAt count.
async function findCachedDocs(userRef, jobId, profileUpdatedAt) {
  const validFrom = profileUpdatedAt?.toMillis?.() || 0;
  const snap = await userRef.collection('applications')
    .where('jobId', '==', jobId)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (!d.resumeVersionId || !d.coverLetterId || !d.resumePath || !d.coverPath) continue;
    if ((d.createdAt?.toMillis?.() || 0) < validFrom) continue;
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
    const pause = await waitForHuman(page, ctx, await detectPause(page, ctx));
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
      const still = captchaInForm && (await waitForHuman(page, ctx, pause));
      if (still) return { status: 'blocked', error: still, portalUrl: page.url() };
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
  const popup = await clickApply(page);
  // Workday answers Apply with a chooser: Autofill with Resume / Apply Manually / Use My Last Application.
  const manual = (popup || page).locator('[data-automation-id="applyManually"], a:has-text("Apply Manually"), button:has-text("Apply Manually")').first();
  if (await manual.isVisible().catch(() => false)) { await manual.click().catch(() => {}); await (popup || page).waitForTimeout(1500); }
  return popup;
}

async function clickApply(page) {
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

// Job boards redirect Apply clicks to unrelated sponsored postings, and employer links land on
// other roles at the same company (an intern application once reached a Senior Director page).
// A page heading must carry most of the job's title, at the same seniority, AND the page must
// name the employer, before a single field is touched. A false block costs a manual apply; a
// false pass sends a real application to the wrong job.
const TITLE_NOISE = /^(and|the|for|of|in|to|at|with|fall|winter|spring|summer|term|month|remote|hybrid|onsite|\d+)$/;
const SENIORITY = /^(senior|director|manager|vp|vice|president|principal|lead|head|chief|executive)$/;
const COMPANY_NOISE = /^(inc|ltd|llc|the|group|corp|company|canada|limited|co)$/;

function titleTokens(v) {
  return String(v || '').toLowerCase()
    .replace(/co-?\s?op\b/g, 'coop').replace(/\binternships?\b/g, 'intern').replace(/\bsr\b\.?/g, 'senior')
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .map((w) => (w.length > 3 ? w.replace(/s$/, '') : w))
    .filter((w) => w.length > 1 && !TITLE_NOISE.test(w));
}

// headings: the page's title/h1/h2 strings. text: lowercased page text plus URL.
export function postingMatches(job, headings, text) {
  const want = titleTokens(job.title);
  if (!want.length) return false;
  const titleOk = headings.some((h) => {
    const have = new Set(titleTokens(h));
    if ([...have].some((w) => SENIORITY.test(w) && !want.includes(w))) return false;
    return want.filter((w) => have.has(w)).length >= Math.ceil(want.length * 0.6);
  });
  if (!titleOk) return false;
  const company = String(job.company || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !COMPANY_NOISE.test(w));
  return company.length === 0 || company.some((w) => text.includes(w));
}

export async function landedOnDifferentPosting(page, job) {
  const seen = await page.evaluate(() => ({
    headings: [document.title, document.querySelector('meta[property="og:title"]')?.content, ...[...document.querySelectorAll('h1, h2')].slice(0, 12).map((h) => h.innerText)].filter(Boolean),
    text: (location.href + ' ' + document.title + ' ' + (document.body?.innerText || '').slice(0, 8000)).toLowerCase(),
  })).catch(() => null);
  if (!seen || !seen.text.trim()) return 'page did not render';
  // iCIMS (Mackenzie) titles its page "Job Opportunities" and keeps the posting in an iframe; the
  // title is in the URL slug (/jobs/5997/winter-intern-2027-business-analyst/login) and the frame.
  let slug = '';
  try { slug = decodeURIComponent(new URL(page.url()).pathname).replace(/[-_/+]+/g, ' '); } catch { /* malformed escape: no slug */ }
  const framed = (await Promise.all(page.frames().slice(1, 6).map((f) => f.evaluate(() => [...document.querySelectorAll('h1, h2')].slice(0, 6).map((h) => h.innerText)).catch(() => [])))).flat();
  if (postingMatches(job, [...seen.headings, slug, ...framed].filter(Boolean), seen.text)) return null;
  return (seen.headings[1] || seen.headings[0] || 'unknown page').trim().slice(0, 120);
}

// ---- Paradox chat-bot applications (Loblaw's "Alex") --------------------------------
// The application is a conversation inside an <apply-widget> open shadow root: Apply Now opens
// the chat, the Terms are accepted in a dialog, then the bot asks one question at a time. Every
// reply is sent to the employer for real, so there is no dry run, and a question the answers
// bank cannot answer stops the run instead of guessing.
const CHAT_DONE = /application (has been|was|is) (submitted|received|complete)|thank(s| you) for applying|successfully (applied|submitted)|(we|i)('ve| have) (received|submitted) your application/i;
// The last alternative: first-person statements the bot wants agreed to with Yes / No ("I understand
// that this job requires a commitment to full-time hours ..."). They stalled Loblaw's chat.
const CHAT_ASKS = /\?|please|what|which|enter|provide|upload|attach|select|choose|type|tell|share|confirm|are you|do you|have you|can you|\bi (understand|acknowledge|agree|certify|consent|am (aware|able|willing))\b/i;
const MAX_CHAT_TURNS = 40;

// The part of a bot turn that is the question: drop leading pleasantries ("Thanks, Nirupam!").
export function chatQuestion(message) {
  const sentences = String(message || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const i = sentences.findIndex((t) => CHAT_ASKS.test(t));
  return i < 0 ? '' : sentences.slice(i).join(' ');
}

async function handleParadoxChat(page, ctx, docs, appRef, screenshots, allFields) {
  const blocked = async (error) => { await takeShot(page, appRef, screenshots); return { status: 'blocked', error, portalUrl: page.url() }; };
  if (!ctx.autoSubmit) return blocked('chat-bot application: every reply is sent for real, so it cannot be dry-run');
  const w = page.locator('apply-widget');
  const botMessages = () => w.locator('[data-testid="messenger_lbl_ours"] .ol-text-message[aria-hidden="true"]').allInnerTexts().catch(() => []);
  // The bot types in bursts; a turn is over once the transcript has been still for 5 s.
  const settled = async () => {
    let last = -1, still = 0;
    for (let i = 0; i < 30 && still < 5; i++) { await page.waitForTimeout(1000); const n = (await botMessages()).join('').length; still = n === last ? still + 1 : 0; last = n; }
    return botMessages();
  };

  await w.locator('button[aria-label="Close widget chat"]').click({ timeout: 3000 }).catch(() => {});
  await page.locator('a.apply-button, a:has-text("Apply Now"), button:has-text("Apply Now")').first().click({ timeout: 8000 }).catch(() => {});
  await ctx.log?.('chat-bot application (Paradox): answering the assistant one question at a time');

  let answered = 0, idle = 0, lastAsked = '', termsDone = false;
  for (let turn = 0; turn < MAX_CHAT_TURNS; turn++) {
    const msgs = await settled();
    // A returning visitor gets the earlier conversation back; only its last message is pending.
    if (turn === 0) answered = Math.max(0, msgs.length - 1);
    const pause = await waitForHuman(page, ctx, await detectPauseRaw(page));
    if (isCaptcha(pause)) return blocked(pause);

    const terms = w.getByText('Review Terms').first();
    // Once only: the "Review Terms" card stays in the transcript after it has been accepted.
    if (!termsDone && /terms/i.test(msgs.at(-1) || '') && (await terms.isVisible().catch(() => false))) {
      termsDone = true;
      await terms.click().catch(() => {});
      await w.locator('[role=dialog] button:has-text("Accept")').click({ timeout: 8000 }).catch(() => {});
      allFields.push({ name: 'Terms of Use', value: 'Accepted', confidence: 'green' });
      answered = msgs.length; // the greeting asked for the Terms; it is not a question to answer
      continue;
    }

    const fresh = msgs.slice(answered).join(' ');
    if (CHAT_DONE.test(fresh)) { await takeShot(page, appRef, screenshots); return { status: 'submitted', confirmation: msgs.at(-1).slice(0, 300), portalUrl: page.url() }; }
    const question = chatQuestion(fresh);
    if (!question) { if (++idle >= 3) return blocked(`chat stalled after: ${(msgs.at(-1) || 'no message').slice(0, 160)}`); continue; }
    if (question === lastAsked) return blocked(`the assistant did not accept the answer to: ${question.slice(0, 160)}`);
    idle = 0; lastAsked = question; answered = msgs.length;

    let field;
    const upload = w.locator('input[type=file]:not([accept^="video"])').first();
    // Quick replies belong to the newest turn only; older cards ("Review Terms") stay in the transcript.
    const lastTurn = w.locator('.me-messages__inner [role=listitem]').last();
    // Two kinds of reply controls: "select one" cards inside the newest turn, and a quick-reply
    // bar (Yes / No) that sits under the transcript, outside it.
    const CHOICE = ':is(button, [role=button], [role=option], [role=radio], [role=checkbox], li.el-select-dropdown__item):visible';
    const choices = w.locator('[data-testid="widget_convo"]').locator(CHOICE);
    const texts = async (loc) => (await loc.allInnerTexts().catch(() => [])).map((t) => t.trim()).filter((t) => t && !/^(review terms|done|view)$/i.test(t));
    const composer = w.locator('#widget_composer_input');
    // The bot disables the composer when it wants a choice, and the card can render a few seconds
    // after its question. Look until choices show up or typing is allowed.
    let options = [];
    for (let i = 0; i < 10; i++) {
      // A "select one" card can also be a dropdown; its items only exist on screen once it is open.
      // The open list is a popper attached to the widget root, outside the turn and the transcript.
      const dropdown = lastTurn.locator('.el-select input[readonly]').first();
      const items = w.locator('li.el-select-dropdown__item:visible');
      if ((await dropdown.isVisible().catch(() => false)) && !(await items.count().catch(() => 0))) {
        await dropdown.click().catch(() => {});
        await items.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      }
      const inTranscript = new Set(await texts(w.locator('.me-messages__inner').locator(CHOICE)));
      options = [...new Set([...(await texts(lastTurn.locator(CHOICE))), ...(await texts(items)), ...(await texts(choices)).filter((t) => !inTranscript.has(t))])];
      if (options.length || !(await composer.isDisabled().catch(() => false))) break;
      await page.waitForTimeout(1000);
    }
    const datePicker = lastTurn.locator('input.flatpickr-input').first();
    const wantsDate = (await datePicker.count().catch(() => 0)) > 0;
    if (!wantsDate && !options.length && (await composer.isDisabled().catch(() => false))) return blocked(`the assistant wants a choice this agent cannot see for: ${question.slice(0, 160)}`);
    if (/resume|r\u00e9sum\u00e9|\bcv\b/i.test(question) && (await upload.count().catch(() => 0))) {
      await docs.ready();
      await upload.setInputFiles(docs.resumePath);
      field = { name: question, value: path.basename(docs.resumePath), confidence: 'green' };
    } else {
      const { value, confidence } = await getAnswer(ctx, question, options.length ? options : undefined);
      // A chat reply cannot be reviewed or taken back, so only profile rules and answers the user
      // typed or approved are sent. A guessed answer waits on the Answers page.
      if (!value || confidence !== 'green') {
        const gap = { name: question, value: value || '', confidence: 'red' };
        allFields.push(gap); await recordFields(appRef, [gap]);
        return blocked(value ? `approve the suggested answer on the Answers page, then retry: ${question.slice(0, 140)}` : `no answer for the assistant's question (add it on the Answers page): ${question.slice(0, 140)}`);
      }
      if (wantsDate) {
        // Calendar card (flatpickr): set the date through the widget, then confirm with Done.
        const my = value.match(/^([A-Za-z]{3})[a-z]*\.? (\d{4})$/); // "June 2028", "Sept 2028"
        const when = new Date(my ? `1 ${my[1]} ${my[2]}` : value);
        if (Number.isNaN(when.getTime())) return blocked(`could not read "${value}" as a date for: ${question.slice(0, 120)}`);
        await datePicker.evaluate((el, iso) => el._flatpickr.setDate(new Date(iso), true), when.toISOString());
        await lastTurn.locator('[data-testid="select_list_btn_submit"]:not([disabled])').click({ timeout: 5000 });
      } else if (options.includes(value)) {
        await w.locator(CHOICE).getByText(value, { exact: true }).last().click();
        await lastTurn.locator('[data-testid="select_list_btn_submit"]:not([disabled])').click({ timeout: 3000 }).catch(() => {}); // "Please select one" cards confirm with Done
      }
      else {
        await composer.fill(value);
        await w.locator('button.send-message-btn').click();
      }
      field = { name: question, value, confidence };
    }
    allFields.push(field); await recordFields(appRef, [field]);
    await ctx.log?.(`assistant: ${question.slice(0, 120)} -> ${field.value.slice(0, 60)}`);
    if (turn % 6 === 5) await takeShot(page, appRef, screenshots);
  }
  return blocked('chat exceeded the maximum number of turns');
}

async function handleGeneric(page, ctx, docs, appRef, screenshots, allFields) {
  // Verify the posting on the page we were sent to, before clicking anything on it.
  await settle(page);
  const wrong = await landedOnDifferentPosting(page, ctx.job);
  if (wrong) return { status: 'blocked', error: `landed on a different posting: ${wrong}`, portalUrl: page.url() };
  if (await page.locator('apply-widget').count().catch(() => 0)) return handleParadoxChat(page, ctx, docs, appRef, screenshots, allFields);
  const popup = await revealApplyForm(page);
  if (popup) page = popup; // reassigning the parameter: every use below now targets the new tab
  const host = hostOf(page.url());
  let lastStep = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    await settle(page); // single-page ATSs render well after load; never scan a blank shell
    let pause = await detectPause(page, ctx);
    // A CAPTCHA beside a form's Submit is left for last in a visible run: its token expires about
    // two minutes after it is solved, so the form is filled first. A full-page challenge (no
    // Submit/Next on the page) has to be cleared before anything else.
    const captchaInForm = ctx.headed && isCaptcha(pause) && !!(await findByText(page, [...SUBMIT_TEXTS, ...NEXT_TEXTS]));
    if (!captchaInForm) pause = await waitForHuman(page, ctx, pause);
    if (pause && !captchaInForm) return { status: 'blocked', error: pause };

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

    // Same step as last round and nothing left to fill: Next was refused. Say why now instead of
    // pressing it ten more times (a rejected phone format cost 9 minutes on Manulife).
    // (Uploads and re-ticked boxes repeat every round, so "same step, same fills" is the test.)
    const thisStep = `${await stepSignature(page)}|${fields.map((f) => `${f.name}=${f.value}`).join(';')}`;
    if (thisStep === lastStep) {
      const why = await visibleErrors(page);
      return { status: 'blocked', error: `the form did not move on${why ? `: ${why}` : ' (no error shown)'}`, portalUrl: page.url() };
    }
    lastStep = thisStep;

    const submitBtn = await findByText(page, SUBMIT_TEXTS);
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
    // Same rule as Submit: a page with empty required fields will not advance, and clicking Next
    // at it for twelve rounds cost 13 minutes per job on Phenom forms (RBC, Manulife).
    const gapsBeforeNext = await invalidRequired(page);
    if (gapsBeforeNext.length || ctx._requiredGap) {
      const names = gapsBeforeNext.length ? gapsBeforeNext : fields.filter((f) => f.confidence === 'red' && !f.value).map((f) => f.name);
      return { status: 'blocked', error: `required field(s) left empty: ${names.slice(0, 4).join(' | ')}`, portalUrl: page.url() };
    }
    const stillNext = captchaInForm && (await waitForHuman(page, ctx, pause));
    if (stillNext) return { status: 'blocked', error: stillNext, portalUrl: page.url() };
    const nextTxt = await clickByText(page, page, NEXT_TEXTS);
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
    if (!(job.score >= MIN_APPLY_SCORE)) throw new Error(`match score ${job.score ?? 'unknown'} is below ${MIN_APPLY_SCORE}; not applying`);

    const profileSnap = await userRef.collection('profile').doc('profile').get();
    const profile = profileSnap.exists ? profileSnap.data() : emptyProfile();

    const settingsSnap = await userRef.collection('settings').doc('applications').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const autoSubmit = typeof payload.autoSubmit === 'boolean' ? payload.autoSubmit : !!settings.autoSubmit;

    const email = payload.email || resolveApplicationEmail(profile, settings);
    let docs;
    if (payload.resumePath && payload.coverPath) {
      const given = { resumeVersionId: payload.resumeVersionId || null, coverLetterId: payload.coverLetterId || null, resumePath: payload.resumePath, coverPath: payload.coverPath };
      docs = lazyDocs(email, async () => given);
      await appendLog('using provided document paths (override)');
    } else {
      docs = lazyDocs(email, async () => {
        let made = await findCachedDocs(userRef, jobId, profile.updatedAt);
        await appendLog(made ? 'reusing documents from a previous attempt on this job' : 'the form takes files: preparing tailored resume and cover letter');
        if (!made) made = await prepareDocuments({ db, uid, log: appendLog }, { jobId });
        await appRef.update({ resumeVersionId: made.resumeVersionId, coverLetterId: made.coverLetterId, resumePath: made.resumePath, coverPath: made.coverPath });
        return made;
      });
    }

    await appRef.update({ status: 'filling', email });

    const urls = applyUrls(job);
    if (!urls.length) throw new Error('job has no apply URL');

    const ctx = { db, uid, profile, settings, job, autoSubmit, headed: !!payload.headed, log: appendLog, startedAt: Date.now(), _requiredGap: false };
    const screenshots = [];
    const allFields = [];

    const tryUrl = async (context, applyUrl) => {
      const page = await context.newPage();
      const res = await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
      if (!res) return { status: 'blocked', error: 'apply page did not load', tryNext: true };
      const status = res.status();
      const html = await page.content().catch(() => '');
      if (status >= 400) return { status: 'blocked', error: `HTTP ${status} loading apply page`, tryNext: true };
      if (looksBlocked({ url: page.url(), title: await page.title().catch(() => ''), html })) {
        // Full-page challenge. Headless: report it (needs_human if no other source works).
        // Visible run: the user clears it in the window, then the agent carries on.
        const wall = `captcha detected (challenge page at ${page.url()})`;
        const still = ctx.headed ? await waitForHuman(page, ctx, wall) : wall;
        if (still) return { status: 'blocked', error: still, tryNext: true };
        await settle(page);
      }
      await appRef.update({ portalUrl: page.url() }).catch(() => {});
      await takeShot(page, appRef, screenshots);

      const host = hostOf(page.url());
      if (host.includes('linkedin.com')) return handleLinkedIn(page, ctx, docs, appRef, screenshots, allFields);
      if (host.includes('ziprecruiter.com')) return handleZipRecruiter(page, ctx, docs, appRef, screenshots, allFields);
      return handleGeneric(page, ctx, docs, appRef, screenshots, allFields);
    };

    const outcome = await withBrowser(async (context) => {
      let last;
      for (const applyUrl of urls) {
        // Only a page that failed to load moves on; an error after a form was touched must never
        // re-apply through another board.
        last = await tryUrl(context, applyUrl).catch((err) => ({ status: 'blocked', error: err.message.split('\n')[0] }));
        const wrongPlace = last.tryNext || /^landed on a different posting/.test(last.error || '');
        if (last.status !== 'blocked' || !wrongPlace) return last;
        await appendLog(`${hostOf(applyUrl)}: ${last.error}${applyUrl === urls.at(-1) ? '' : '; trying the next source'}`);
      }
      return last;
    }, { headed: ctx.headed });

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
      // A CAPTCHA in a headless run is the user's to solve: the dashboard offers a visible rerun.
      const status = isCaptcha(outcome.error) && !ctx.headed ? 'needs_human' : 'blocked';
      await appRef.update({ status, error: outcome.error || 'blocked', portalUrl: outcome.portalUrl || null });
      await appendLog(`${status}: ${outcome.error || 'unknown reason'}`);
      return { applicationId: appRef.id, status, confirmation: null };
    }

    return { applicationId: appRef.id, status: outcome.status === 'submitted' ? 'submitted' : 'blocked', confirmation: outcome.confirmation || null };
  } catch (err) {
    await appRef.update({ status: 'failed', error: err.message }).catch(() => {});
    await appendLog(`failed: ${err.message}`).catch(() => {});
    return { applicationId: appRef.id, status: 'failed', confirmation: null };
  }
}

// Employer + title, city ignored: "Toronto" and "Greater Toronto Area" are the same opening.
export const roleKey = (job) => dedupKey({ ...job, location: '' });

// applyBatch({ db, uid, log }, { jobIds?, limit? })
export async function applyBatch({ db, uid, log }, payload = {}) {
  const userRef = db.collection('users').doc(uid);
  const limit = payload.limit || 200;

  let jobIds = payload.jobIds;
  if (!jobIds || !jobIds.length) {
    // Every job at or above the bar, best first; saving a job is no longer required.
    const snap = await userRef.collection('jobs').where('score', '>=', MIN_APPLY_SCORE).orderBy('score', 'desc').get();
    jobIds = snap.docs.filter((d) => !['dismissed', 'applied'].includes(d.data().status)).slice(0, limit).map((d) => d.id);
  } else {
    jobIds = jobIds.slice(0, limit);
  }

  // The same role is often listed twice (another board, another spelling of the city) under two
  // job ids. One application per employer + title.
  const appliedSnap = await userRef.collection('jobs').where('status', '==', 'applied').get();
  const appliedRoles = new Set(appliedSnap.docs.map((d) => roleKey(d.data())));

  const results = [];
  for (const jobId of jobIds) {
    const already = await userRef.collection('applications').where('jobId', '==', jobId).where('status', '==', 'submitted').limit(1).get();
    const jobSnap = await userRef.collection('jobs').doc(jobId).get();
    const role = jobSnap.exists ? roleKey(jobSnap.data()) : null;
    if (!already.empty || appliedRoles.has(role)) {
      await log(`${jobId}: already applied to this role, skipping`);
      results.push({ jobId, status: 'skipped' });
      continue;
    }
    try {
      await log(`${jobId}: applying`);
      const res = await applyToJob({ db, uid, log }, { jobId });
      results.push({ jobId, ...res });
      if (res.status === 'submitted') {
        appliedRoles.add(role);
        await userRef.collection('jobs').doc(jobId).update({ status: 'applied', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
      }
      await log(`${jobId}: ${res.status}`);
    } catch (err) {
      results.push({ jobId, status: 'failed', error: err.message });
      await log(`${jobId}: failed - ${err.message}`);
    }
  }

  const needsHuman = results.filter((r) => r.status === 'needs_human').length;
  if (needsHuman) notify(`${needsHuman} application(s) stopped at a CAPTCHA. Open Applications and press Solve CAPTCHA when you are at the Mac.`);

  return {
    needsHuman,
    total: jobIds.length,
    submitted: results.filter((r) => r.status === 'submitted').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  };
}
