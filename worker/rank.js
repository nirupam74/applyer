import { createHash } from 'node:crypto';
import { ask } from './llm.js';

const COMPANY_NOISE = /\b(inc|inc\.|ltd|ltd\.|llc|corp|corporation|co|company|limited|group|canada|the)\b/gi;
const TITLE_NOISE = /\((?:[^)]*)\)|\b(f\/m\/d|m\/f\/d|urgent|hiring now|new)\b|[-:|,]\s*(fall|winter|summer|spring)\s*\d{4}.*$/gi;

function squash(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Dedup key = normalized company|title|city. Location keeps only the first
// comma segment so "Toronto, ON" and "Toronto, Ontario, Canada" collide.
export function dedupKey(job) {
  // ponytail: first company token only, so "Klick" and "Klick Health" collide; upgrade to a fuzzy match if false merges appear
  const company = squash(String(job.company || '').replace(COMPANY_NOISE, '')).split(' ')[0] || '';
  const title = squash(String(job.title || '').replace(TITLE_NOISE, ''));
  const city = squash(String(job.location || '').split(',')[0]);
  return `${company}|${title}|${city}`;
}

export function jobId(job) {
  return createHash('sha1').update(dedupKey(job)).digest('hex').slice(0, 20);
}

// Merge a freshly scraped job onto an existing one: keep the longer
// description, union the sources, prefer a known posted date.
export function mergeJob(existing, incoming) {
  const src = { name: incoming.source, url: incoming.url, applyUrl: incoming.applyUrl || incoming.url };
  if (!existing) {
    const { source, url, applyUrl, externalId, ...rest } = incoming;
    return { ...rest, sources: [src], externalIds: externalId ? { [source]: externalId } : {} };
  }
  const out = { ...existing };
  if (!out.sources.some((s) => s.name === src.name)) out.sources = [...out.sources, src];
  if (incoming.externalId) out.externalIds = { ...(out.externalIds || {}), [incoming.source]: incoming.externalId };
  if ((incoming.description || '').length > (out.description || '').length) out.description = incoming.description;
  if (!out.salary && incoming.salary) out.salary = incoming.salary;
  if (!out.postedAt && incoming.postedAt) out.postedAt = incoming.postedAt;
  if ((!out.workMode || out.workMode === 'unknown') && incoming.workMode) out.workMode = incoming.workMode;
  if (!out.employmentType && incoming.employmentType) out.employmentType = incoming.employmentType;
  return out;
}

// Turns preferences into search queries. Slash alternatives become separate
// titles ("Social Media / Content Marketing Intern" -> two queries). A trailing level
// ("Research Technician II") is dropped: the boards match it anyway, and I / II / III are one query.
export function buildQueries(profile) {
  const prefs = profile.preferences || {};
  const titles = new Map(); // lowercased -> as typed
  const add = (t) => {
    const q = t.replace(/\s+/g, ' ').replace(/\s+(i{1,3}|iv|v|[1-5])$/i, '').trim();
    if (q && !titles.has(q.toLowerCase())) titles.set(q.toLowerCase(), q);
  };
  for (const raw of prefs.titles || []) {
    const t = String(raw).trim();
    if (!t) continue;
    const m = t.match(/^(.*?)\s\/\s(.*?)\s(\S+(?:\s\S+)?)$/); // "A / B Rest"
    if (m) {
      add(`${m[1]} ${m[3]}`);
      add(`${m[2]} ${m[3]}`);
    } else {
      add(t);
    }
  }
  if (titles.size === 0 && profile.experience && profile.experience[0]) add(String(profile.experience[0].title || ''));
  const fallback = profile.personal && profile.personal.location;
  const locations = [...new Set((prefs.locations || []).map((l) => searchLocation([l])).filter((l) => l !== 'Canada'))].slice(0, 3);
  if (!locations.length) locations.push(searchLocation([], fallback));
  return { titles: [...titles.values()].slice(0, 30), location: locations[0], locations };
}

export function searchLocation(locations, fallback) {
  const first = (locations || []).map((l) => String(l).trim()).find(Boolean);
  const raw = first || fallback || '';
  if (/greater toronto|gta/i.test(raw)) return 'Toronto, ON';
  return raw.replace(/,\s*Ontario\b/i, ', ON') || 'Canada';
}

const INTERN = /\b(intern(ship)?s?|co-?op)\b/i; // not "internal" / "international"
// Any of these counts as "in the GTA" for a member whose preferred cities are there.
const GTA = /\b(gta|greater toronto|toronto|north york|scarborough|etobicoke|east york|mississauga|brampton|markham|vaughan|richmond hill|thornhill|oakville|burlington|milton|pickering|ajax|whitby|oshawa|newmarket|aurora|caledon)\b/;
const SENIOR = /\b(senior|sr\.?|lead|principal|director|head of|manager|vp|chief|staff)\b/i;
const STOP = new Set(['and', 'or', 'the', 'of', 'intern', 'internship', 'co', 'op', 'coop', 'a', 'an', 'in', 'for']);

function tokens(s) {
  return squash(s).split(' ').filter((w) => w && !STOP.has(w));
}

// Deterministic 0-100 heuristic. Title fit 40, employment type 15, location 15,
// recency 15, skills 15, minus a level penalty: senior roles for intern/junior profiles,
// intern/co-op roles for everyone else (they require enrolment).
export function heuristicScore(job, profile, now = new Date()) {
  const prefs = profile.preferences || {};
  const titleToks = new Set(tokens(job.title));

  let titleFit = 0;
  for (const pref of prefs.titles || []) {
    for (const variant of pref.split(/\s\/\s/)) {
      const pt = tokens(variant);
      if (!pt.length) continue;
      const hit = pt.filter((w) => titleToks.has(w)).length / pt.length;
      titleFit = Math.max(titleFit, hit);
    }
  }
  let score = Math.round(titleFit * 40);

  const wantsIntern = (prefs.employmentType || []).some((t) => /intern|co-?op/i.test(t)) || /intern|co-?op|junior/i.test(prefs.seniority || '');
  const jobIsIntern = INTERN.test(`${job.title} ${job.employmentType || ''}`);
  const typeMatch = (prefs.employmentType || []).some((t) => squash(t).split(' ')[0] === squash(job.employmentType || '').split(' ')[0]);
  if (typeMatch || (wantsIntern && jobIsIntern)) score += 15;
  else if (!job.employmentType) score += 5;

  const loc = squash(job.location);
  const cities = (prefs.locations || []).map((l) => squash(l.split(',')[0])).filter(Boolean);
  if (job.workMode === 'remote' && prefs.remote !== 'onsite') score += 15;
  else if (cities.some((c) => c && loc.includes(c)) || (GTA.test(loc) && cities.some((c) => GTA.test(c)))) score += 15;
  else if (/ontario|\bon\b/.test(loc) && cities.length) score += 7;
  else if (!loc) score += 3;

  const posted = job.postedAt instanceof Date ? job.postedAt : job.postedAt && job.postedAt.toDate ? job.postedAt.toDate() : null;
  if (posted) {
    const days = (now - posted) / 86400e3;
    score += days <= 3 ? 15 : days <= 7 ? 12 : days <= 14 ? 8 : days <= 30 ? 4 : 0;
  } else score += 5;

  const text = squash(`${job.title} ${job.description || ''}`);
  const skillTerms = Object.values(profile.skills || {}).flat().map((s) => squash(String(s).split(/[(/&,]/)[0])).filter((s) => s.length > 3);
  const hits = new Set(skillTerms.filter((s) => text.includes(s))).size;
  score += Math.min(15, hits * 3);

  if (wantsIntern && SENIOR.test(job.title) && !jobIsIntern) score -= 25;
  if (!jobIsIntern && wantsIntern && /\b(5|6|7|8|9|10)\+?\s*years/.test(text)) score -= 10;
  if (!wantsIntern && jobIsIntern) score -= 25;

  return Math.max(0, Math.min(100, score));
}

export function finalScore(heuristic, matchPct) {
  if (typeof matchPct !== 'number') return heuristic;
  return Math.round(0.35 * heuristic + 0.65 * matchPct);
}

// What the LLM ranking depends on besides the resume. A stored analysis made under other
// preferences is redone on the next search; one without a key (older data) is kept.
export function prefsKey(profile) {
  return createHash('sha1').update(JSON.stringify([profile.preferences || {}, profile.workAuthorization || '', profile.availability || ''])).digest('hex').slice(0, 12);
}

function profileSummary(profile) {
  const p = profile;
  return {
    education: (p.education || []).map((e) => `${e.degree || ''} ${e.program || e.major || ''} ${e.institution || ''} ${e.graduation || e.end || ''}`.trim()),
    experience: (p.experience || []).map((e) => ({
      title: e.title,
      company: e.company,
      dates: `${e.start || ''} to ${e.end || ''}`,
      bullets: [...(e.responsibilities || []), ...(e.achievements || [])].slice(0, 6),
    })),
    projects: (p.projects || []).map((x) => `${x.name || ''}: ${x.description || ''}`.slice(0, 300)),
    publications: (p.publications || []).map((c) => String(c).slice(0, 200)),
    skills: p.skills || {},
    preferences: p.preferences || {},
    workAuthorization: p.workAuthorization || (p.demographics?.citizenship ? `${p.demographics.citizenship} citizen` : ''),
    availability: p.availability || '',
  };
}

const ANALYSIS_SHAPE = `{"results": [{"id": "<job id exactly as given>", "matchPct": <integer 0-100>,
"strong": ["<up to 5 requirements the candidate clearly meets, cite the profile fact>"],
"missing": ["<up to 5 requirements the profile does not show>"],
"advantages": ["<up to 3 things that make this candidate stand out for this job>"],
"concerns": ["<up to 3 concerns: seniority, location, work authorization, pay, fit>"],
"recommendation": "<one of: apply | maybe | skip>"}]}`;

// LLM analysis for up to 10 jobs in one call. Returns a map id -> analysis.
export async function analyzeBatch(jobs, profile) {
  const summary = profileSummary(profile);
  const jobBlock = jobs
    .map(
      (j, i) =>
        `--- JOB ${i + 1} (id: ${j.id}) ---\nTitle: ${j.title}\nCompany: ${j.company}\nLocation: ${j.location} (${j.workMode})\n` +
        `Type: ${j.employmentType || 'unknown'}\nSalary: ${j.salary || 'not listed'}\nDescription:\n${(j.description || 'No description available; judge from the title only.').slice(0, 2500)}`,
    )
    .join('\n\n');
  const prompt =
    `You are ranking job postings for a candidate. Score each job for how well the CANDIDATE fits the JOB and how well the job fits the candidate's stated preferences. ` +
    `matchPct: 85+ only when the candidate meets nearly every requirement and the role matches their preferred titles and level; 60-84 solid partial fit; below 40 when the level, field, or authorization is wrong. ` +
    `Return one result per job, ids exactly as given.\n\nCANDIDATE PROFILE:\n${JSON.stringify(summary)}\n\nJOBS:\n${jobBlock}`;
  const out = await ask(prompt, ANALYSIS_SHAPE);
  const map = {};
  for (const r of (out && out.results) || []) {
    if (!r || !r.id) continue;
    const pct = Number(r.matchPct);
    map[r.id] = {
      matchPct: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null,
      strong: arr(r.strong),
      missing: arr(r.missing),
      advantages: arr(r.advantages),
      concerns: arr(r.concerns),
      recommendation: ['apply', 'maybe', 'skip'].includes(r.recommendation) ? r.recommendation : 'maybe',
    };
  }
  return map;
}

const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 6) : []);
