import admin from 'firebase-admin';
import { ask } from '../llm.js';

const FieldValue = admin.firestore.FieldValue;

const norm = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim().toLowerCase());

// ---- sponsorship / work-authorization -----------------------------------
// The one rule apply.py got burned by: "eligible to work without sponsorship?" contains
// both "eligible" and "sponsorship", so authorization must be classified before sponsorship.
export function classifyWorkAuth(text) {
  const t = norm(text);
  if (!t) return { authorized: null, needsSponsorship: null };
  const noSponsorship = /citizen|permanent resident|\bpr\b|no sponsorship|without sponsorship|does not require sponsorship|not require sponsorship/.test(t);
  const needsSponsorship =
    (/sponsorship/.test(t) && /require|need|will/.test(t)) || (/visa/.test(t) && /require|need/.test(t)) || /work permit needed/.test(t);
  return {
    authorized: noSponsorship || /authorized|eligible to work/.test(t) ? true : needsSponsorship ? false : null,
    needsSponsorship: noSponsorship ? false : needsSponsorship ? true : null,
  };
}

const yesNo = (b) => (b == null ? null : b ? 'Yes' : 'No');

// ---- years of experience --------------------------------------------------
export function yearsOfExperience(profile) {
  const exp = (profile && profile.experience) || [];
  if (!exp.length) return null;
  const now = new Date();
  const parseYear = (s) => {
    if (!s) return null;
    const t = String(s).toLowerCase();
    if (/present|current|now/.test(t)) return now.getFullYear() + now.getMonth() / 12;
    const m = t.match(/(19|20)\d{2}/);
    return m ? Number(m[0]) : null;
  };
  let total = 0;
  for (const e of exp) {
    const start = parseYear(e.start);
    const end = parseYear(e.end) ?? now.getFullYear();
    if (start != null && end != null && end >= start) total += end - start;
  }
  return total ? Math.round(total) : null;
}

// ---- deterministic field rules --------------------------------------------
// First matching rule wins, so precedence matters: identity/contact first, then
// authorization/sponsorship (before the generic "country" catch-all below them),
// then education/demographics, then broad location/address last.
const RULES = [
  // Chat-bots ask whether to START an optional diversity survey ("Would you like to share?").
  // Declined: it is voluntary, unused in screening, and opens a run of extra questions. First, so
  // the gender/ethnicity rules below do not claim the question.
  { re: /voluntar(y|ily).{0,200}would you like to share|would you like to (share|self.?identify)/i, get: () => 'No' },
  // A chat-bot's closing check of the answers this agent just gave; it only runs with autoSubmit on.
  { re: /is all (of )?the information.{0,40}correct/i, get: () => 'Yes' },
  { re: /email/i, get: (p, s) => s.email || p.personal?.email },
  // Not "Phone Extension" / "Phone Device Type": a live Workday run put the number in the extension box.
  { re: /^(?!.*\b(extension|ext|device|type)\b).*(phone|mobile|telephone)/i, get: (p) => p.personal?.phone },
  { re: /first (and|&|\/) ?last name/i, get: (p) => p.personal?.name }, // before the last-name rule, which it also matches
  { re: /first name|given name/i, get: (p) => firstOf(p.personal?.name) },
  { re: /last name|family name|surname/i, get: (p) => lastOf(p.personal?.name) },
  { re: /full name|your name|legal name|^name$/i, get: (p) => p.personal?.name },
  { re: /prefer.{0,30}contact|contact.{0,30}prefer|preferred (method|way) of (contact|communication)/i, get: () => 'Email Only' },
  { re: /linkedin/i, get: (p) => p.personal?.linkedin },
  { re: /portfolio|personal site|website/i, get: (p) => p.personal?.portfolio || p.personal?.website },
  {
    re: /legally eligible|authorized to work|eligible to work|right to work|work authorization|authorized to be employed/i,
    get: (p) => yesNo(classifyWorkAuth(p.workAuthorization).authorized),
  },
  {
    re: /require sponsorship|need sponsorship|will you require|sponsorship now or in the future|require.*visa|need.*visa/i,
    get: (p) => yesNo(classifyWorkAuth(p.workAuthorization).needsSponsorship),
  },
  { re: /citizenship/i, get: (p) => p.demographics?.citizenship || p.workAuthorization },
  // preferences.hourlyMin (the user's floor is Ontario's minimum wage) answers in the unit the
  // question asks for: hourly, or annualised at 40 h x 52 weeks.
  { re: /salary|compensation expectation|pay expectation|hourly (rate|wage)|expected (pay|wage)/i, get: (p, s, q) => {
    const h = p.preferences?.hourlyMin;
    if (!h) return p.preferences?.salaryMin ? String(p.preferences.salaryMin) : null;
    if (/annual|per year|yearly/i.test(q)) return String(Math.round(h * 2080));
    return /hour/i.test(q) ? String(h) : `$${h} per hour`;
  } },
  { re: /years? of experience/i, get: (p) => { const y = yearsOfExperience(p); return y == null ? null : String(y); } },
  { re: /start date|available to start|availability/i, get: (p) => p.availability },
  { re: /gpa/i, get: (p) => p.education?.[0]?.gpa },
  // The profile stores a span ("Sept 2023 - June 2028 (expected)"); a graduation question wants its end.
  { re: /graduation/i, get: (p) => { const g = p.education?.[0]?.graduation; const m = [...String(g || '').matchAll(/([A-Za-z]{3,9})\.? (\d{4})/g)].pop(); return m ? `${m[1]} ${m[2]}` : g; } },
  { re: /degree/i, get: (p) => p.education?.[0]?.degree },
  { re: /major|field of study|discipline/i, get: (p) => p.education?.[0]?.major || p.education?.[0]?.program },
  { re: /school|university|institution|college/i, get: (p) => p.education?.[0]?.institution },
  { re: /pronoun/i, get: (p) => p.demographics?.pronouns || 'Prefer not to answer' },
  { re: /gender/i, get: (p) => p.demographics?.gender || 'Prefer not to answer' },
  { re: /ethnicity|race\b|hispanic|latino/i, get: (p) => p.demographics?.ethnicity || 'Prefer not to answer' },
  { re: /disability/i, get: (p) => p.demographics?.disability || 'Prefer not to answer' },
  { re: /veteran|military/i, get: (p) => p.demographics?.veteran || 'Prefer not to answer' },
  // location is "City, Province, Country" or just "Province, Country": never answer City with a province.
  { re: /^city\b|city\/town|current location|location \(city\)/i, get: (p) => p.personal?.city || (parts(p.personal?.location).length >= 3 ? firstPart(p.personal?.location) : null) },
  { re: /postal|zip code/i, get: (p) => p.personal?.postalCode },
  { re: /province|state/i, get: (p) => partAt(p.personal?.location, Math.max(0, parts(p.personal?.location).length - 2)) },
  { re: /phone (device )?type/i, get: () => 'Mobile' },
  { re: /country/i, get: (p) => lastPart(p.personal?.location) },
  { re: /location|address/i, get: (p) => p.personal?.location },
];

function firstOf(name) { return name ? name.trim().split(/\s+/)[0] : null; }
function lastOf(name) { return name ? name.trim().split(/\s+/).slice(-1)[0] : null; }
function parts(loc) { return (loc || '').split(',').map((s) => s.trim()).filter(Boolean); }
function firstPart(loc) { return parts(loc)[0] || null; }
function partAt(loc, i) { return parts(loc)[i] || null; }
function lastPart(loc) { const p = parts(loc); return p.length ? p[p.length - 1] : null; }

// applyRules: pure, synchronous, no db/LLM — the deterministic layer, directly testable.
export function applyRules(profile, settings, question) {
  const p = profile || {};
  const s = settings || {};
  for (const rule of RULES) {
    if (rule.re.test(question)) {
      const raw = rule.get(p, s, question);
      if (raw != null && String(raw).trim() !== '') return String(raw).trim();
    }
  }
  return null;
}

// ---- picking among options (select/radio/react-select) --------------------
// Confidence is downgraded to red by the caller whenever this had to fuzzy-match.
function resolveOption(value, options) {
  if (!options || !options.length) return { text: value, fuzzy: false };
  const v = norm(value);
  const exact = options.find((o) => norm(o) === v);
  if (exact) return { text: exact, fuzzy: false };
  if (/^(yes|true)$/i.test(value)) {
    const yes = options.find((o) => /^yes\b/i.test(o.trim()));
    if (yes) return { text: yes, fuzzy: false };
  }
  if (/^(no|false)$/i.test(value)) {
    const no = options.find((o) => /^no\b/i.test(o.trim()));
    if (no) return { text: no, fuzzy: false };
  }
  const contains = options.find((o) => norm(o).includes(v) || v.includes(norm(o)));
  if (contains) return { text: contains, fuzzy: true };
  return { text: null, fuzzy: true };
}

// "linkedin.com/in/x" and "www.site.com" (as written on a resume) fail URL validation on Phenom
// forms ("Please enter a valid LinkedIn URL"); a full URL is accepted everywhere. Manulife's
// form also refused https://linkedin.com/...: LinkedIn links go out in the canonical www form.
export const fullUrl = (v) => {
  const li = String(v).match(/^(?:https?:\/\/)?(?:www\.)?(linkedin\.com\/\S+)$/i);
  if (li) return `https://www.${li[1]}`;
  return /^(www\.)?[\w-]+(\.[\w-]+)*\.(com|ca|io|dev|org|net|co|me|app)(\/\S*)?$/i.test(v) ? `https://${v}` : v;
};

function withOptions(rawValue, options, confidence) {
  if (rawValue == null) return { value: null, confidence: 'red' };
  if (!options || !options.length) return { value: fullUrl(rawValue), confidence };
  const { text, fuzzy } = resolveOption(rawValue, options);
  if (!text) return { value: null, confidence: 'red' };
  return { value: text, confidence: fuzzy ? 'red' : confidence };
}

// ---- answers bank (users/{uid}/answers) ------------------------------------
async function bankMatch(db, uid, question) {
  if (!db || !uid) return null;
  const key = norm(question);
  if (!key) return null;
  const snap = await db.collection('users').doc(uid).collection('answers').where('questionKey', '==', key).limit(1).get();
  if (snap.empty) return null;
  const { answer, approved, source } = snap.docs[0].data();
  if (answer == null || String(answer).trim() === '') return null;
  // trusted: typed or approved by the user. A generated answer nobody has looked at stays yellow.
  return { answer: String(answer).trim(), trusted: !!approved || source === 'user' };
}

// Every question the agent meets lands in the bank with the options the form offered, answered
// or not, so the Answers page can show it and the user can pick or change the answer. An
// existing entry is never overwritten; it only gains options it lacked.
async function recordQuestion(db, uid, question, answer, options) {
  if (!db || !uid) return;
  const key = norm(question);
  if (!key) return;
  const opts = (options || []).map(String).slice(0, 30);
  const col = db.collection('users').doc(uid).collection('answers');
  const snap = await col.where('questionKey', '==', key).limit(1).get();
  if (!snap.empty) {
    // The user's own or approved answers are never touched; a stale generated one may be replaced.
    const cur = snap.docs[0].data();
    const patch = {};
    if (opts.length && !(cur.options || []).length) patch.options = opts;
    if (answer && answer !== cur.answer && cur.source === 'generated' && !cur.approved) patch.answer = answer;
    if (Object.keys(patch).length) await snap.docs[0].ref.update(patch);
    return;
  }
  await col.add({ question, questionKey: key, answer: answer || '', options: opts, tags: [], source: 'generated', approved: false, createdAt: FieldValue.serverTimestamp() });
}

// ---- LLM fallback for free text / essay questions --------------------------
async function llmAnswer(question, profile, job, options) {
  const optCtx = options && options.length ? `\nChoose one of these exact options if one applies: ${JSON.stringify(options)}` : '';
  const jobCtx = job ? `\n\nJob: ${job.title || ''} at ${job.company || ''}\n${String(job.description || '').slice(0, 3000)}` : '';
  const prompt =
    `A job application form asks the candidate this question. Answer briefly using only facts present in the ` +
    `profile JSON below.${optCtx}\n\nQuestion: "${question}"${jobCtx}\n\nCandidate profile (JSON):\n${JSON.stringify(profile || {}).slice(0, 30000)}`;
  const result = await ask(prompt, '{"answer": string|null, "missing": string[]}');
  const answer = result && typeof result.answer === 'string' ? result.answer.trim() : '';
  return answer || null;
}

// getAnswer(ctx, question, options?) -> { value, confidence: 'green'|'yellow'|'red' }
// ctx: { db, uid, profile, settings, job? }. `job` is optional context for the LLM fallback.
// Order: exact answers-bank match, then deterministic rules, then the LLM (saved to the bank).
export async function getAnswer({ db, uid, profile, settings, job }, question, options) {
  if (!question) return { value: null, confidence: 'red' };

  const record = (answer) => recordQuestion(db, uid, question, answer, options).catch(() => {});

  // A banked answer that is not one of this form's options (free text saved before the options
  // were known) does not end the search; the rules and the LLM get to pick from the options.
  // Order: the user's own/approved answer, then profile rules, then an unreviewed generated
  // answer (it must not shadow a rule), then the LLM.
  const bank = await bankMatch(db, uid, question);
  if (bank?.trusted) {
    const res = withOptions(bank.answer, options, 'green');
    await record('');
    if (res.value) return res;
  }

  const rule = applyRules(profile, settings, question);
  if (rule) {
    const res = withOptions(rule, options, 'green');
    // The profile's wording ("Honours Bachelor of Arts") may be none of this form's options
    // ("Degree", "Diploma", "Masters"): then the LLM picks from the list instead of a dead end.
    if (res.value || !options?.length) {
      await record(res.value);
      return res;
    }
  }

  if (bank && !bank.trusted) {
    const res = withOptions(bank.answer, options, 'yellow');
    await record('');
    if (res.value) return res;
  }

  try {
    const answer = await llmAnswer(question, profile, job, options);
    if (answer) {
      const res = withOptions(answer, options, 'yellow');
      await record(res.value);
      return res;
    }
  } catch {
    // fall through to red below — never invent an answer
  }
  await record('');
  return { value: null, confidence: 'red' };
}
