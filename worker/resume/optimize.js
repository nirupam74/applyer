import { ask } from '../llm.js';
import {
  coerceStringArray,
  normalizeEducationItem,
  normalizeExperienceItem,
  normalizeProjectItem,
  normalizeSkills,
  coerceArray,
  coerceString,
} from './extract.js';

const STRUCTURED_SHAPE = `{
  "summary": string (40-120 words),
  "education": [{"institution": string, "degree": string, "program": string, "major": string, "minor": string, "gpa": string, "graduation": string, "coursework": string[]}],
  "experience": [{"company": string, "title": string, "employmentType": string, "start": string, "end": string, "responsibilities": string[] (3-6 rewritten bullets, strong verbs, keep every fact), "achievements": string[], "metrics": string[], "technologies": string[], "skills": string[], "industry": string}],
  "projects": [{"name": string, "description": string, "technologies": string[], "link": string}],
  "publications": string[] (one full citation per entry, copied as written, including manuscripts in preparation or under review),
  "awards": string[] (one line per honour, award, scholarship, certification or licence, with its year),
  "volunteer": string[] (one line per volunteer role or activity: role, organisation, dates) (publications, awards and volunteer come straight from the profile: never reword a citation, and a publication is not a project),
  "skills": {"technical": string[], "tools": string[], "programming": string[], "marketing": string[], "business": string[], "communication": string[], "leadership": string[], "creative": string[], "industry": string[], "certifications": string[], "languages": string[]}
}`;

const SECTIONS = ['summary', 'education', 'experience', 'projects', 'publications', 'awards', 'volunteer', 'skills'];

function normalizeSection(section, value) {
  switch (section) {
    case 'summary':
      return coerceString(value);
    case 'education':
      return coerceArray(value).map(normalizeEducationItem);
    case 'experience':
      return coerceArray(value).map(normalizeExperienceItem);
    case 'projects':
      return coerceArray(value).map(normalizeProjectItem);
    case 'publications':
    case 'awards':
    case 'volunteer':
      return coerceStringArray(value);
    case 'skills':
      return normalizeSkills(value);
    default:
      throw new Error(`Unknown section: ${section}`);
  }
}

function emptyStructured() {
  return {
    summary: '',
    education: [],
    experience: [],
    projects: [],
    publications: [],
    awards: [],
    volunteer: [],
    skills: normalizeSkills({}),
  };
}

export function normalizeStructured(input) {
  const s = input || {};
  return {
    summary: coerceString(s.summary),
    education: coerceArray(s.education).map(normalizeEducationItem),
    experience: coerceArray(s.experience).map(normalizeExperienceItem),
    projects: coerceArray(s.projects).map(normalizeProjectItem),
    publications: coerceStringArray(s.publications),
    awards: coerceStringArray(s.awards),
    volunteer: coerceStringArray(s.volunteer),
    skills: normalizeSkills(s.skills),
  };
}

function normalizeAts(raw, fallbackProblems) {
  const r = raw || {};
  const problems = coerceStringArray(r.problems);
  const score = typeof r.score === 'number' ? Math.max(0, Math.min(100, r.score)) : 0;
  return {
    score,
    problems: problems.length ? problems : fallbackProblems,
    recommendations: coerceStringArray(r.recommendations),
    improvementsMade: coerceStringArray(r.improvementsMade),
    remainingWeaknesses: coerceStringArray(r.remainingWeaknesses),
  };
}

// Deterministic pre-checks. These get appended to the LLM prompt as "Detected problems"
// so the LLM folds them into ats.problems instead of missing them.
export function detectProblems({ profile, originalText, structured }) {
  const problems = [];
  const personal = (profile && profile.personal) || {};
  if (!personal.email) problems.push('missing email in profile');
  if (!personal.phone) problems.push('missing phone in profile');

  const experience = (structured && structured.experience) || (profile && profile.experience) || [];
  experience.forEach((role, i) => {
    const bulletCount = (role.responsibilities || []).length + (role.achievements || []).length;
    const label = role.title || role.company || `role ${i + 1}`;
    if (bulletCount === 0) problems.push(`${label} has zero bullets`);
    else if (bulletCount < 3) problems.push(`${label} has fewer than 3 bullets`);
  });

  if (structured && typeof structured.summary === 'string' && structured.summary.trim()) {
    const wordCount = structured.summary.trim().split(/\s+/).length;
    if (wordCount < 40 || wordCount > 120) {
      problems.push(`summary is ${wordCount} words, outside the 40-120 word range`);
    }
  }

  const lowerText = (originalText || '').toLowerCase();
  for (const heading of ['experience', 'education', 'skills']) {
    if (!lowerText.includes(heading)) problems.push(`missing standard heading: ${heading}`);
  }

  return problems;
}

const ATS_SHAPE = `{"score": number 0-100, "problems": string[], "recommendations": string[], "improvementsMade": string[], "remainingWeaknesses": string[]}`;

// optimizeResume({ profile, originalText, existingStructured, section, job, fitted }) -> { structured, ats }
// job (optional): { title, company, description } - when given, the summary and experience
// bullets are reordered/reworded to target that job, using only facts already in the profile.
// fitted (optional): a structured resume that already fills its page limit; the result keeps its
// size, so the page-fit loop rarely has to condense.
export async function optimizeResume({ profile, originalText, existingStructured, section, job, fitted }) {
  if (section && !SECTIONS.includes(section)) {
    throw new Error(`Unknown section: ${section}`);
  }

  const problems = detectProblems({ profile, originalText, structured: existingStructured });
  const detectedBlock = problems.length
    ? `Detected problems (fold these, worded naturally, into ats.problems):\n${problems.map((p) => `- ${p}`).join('\n')}`
    : 'No deterministic problems were detected.';

  const jobBlock = job && (job.title || job.company || job.description)
    ? `TARGET JOB (reorder and reword the summary and experience bullets to best target this job, using only facts already present in the profile; never invent anything):\nTitle: ${job.title || ''}\nCompany: ${job.company || ''}\nDescription:\n${job.description || ''}`
    : '';

  const base = existingStructured ? normalizeStructured(existingStructured) : emptyStructured();

  if (section) {
    const shape = `{"${section}": <the "${section}" field of ${STRUCTURED_SHAPE}>, "ats": ${ATS_SHAPE}}`;
    const prompt = [
      `Regenerate only the "${section}" section of an ATS-optimized resume. Keep every other section as-is; do not return them. The new "${section}" must be a materially improved rewrite, not a copy of the existing one.`,
      `Candidate profile (source of truth facts):\n${JSON.stringify(profile)}`,
      `Original resume text:\n${originalText || ''}`,
      `Existing structured resume for context:\n${JSON.stringify(base)}`,
      detectedBlock,
      jobBlock,
    ].filter(Boolean).join('\n\n');
    const out = await ask(prompt, shape);
    const structured = { ...base, [section]: normalizeSection(section, out[section]) };
    const ats = normalizeAts(out.ats, problems);
    return { structured, ats };
  }

  const shape = `{"structured": ${STRUCTURED_SHAPE}, "ats": ${ATS_SHAPE}}`;
  const prompt = [
    fitted
      ? 'Produce a full ATS-optimized resume, structured by section, plus an ATS report. It has to fit the page exactly as the LENGTH TEMPLATE does: keep every role, project and degree, the same number of bullets under each, no bullet, summary or skill line longer than its counterpart in the template, and the same number of coursework items. Choose and word the profile facts that serve the target job best; achievement-focused bullets. Achievements must not restate a responsibility bullet: a result belongs either in the bullet or in achievements, never both.'
      : 'Produce a full ATS-optimized resume, structured by section, plus an ATS report. Every experience entry must carry all of its bullets from the profile, rewritten to be achievement-focused; never drop a role or a bullet. Achievements must not restate a responsibility bullet: a result belongs either in the bullet or in achievements, never both.',
    `Candidate profile (source of truth facts):\n${JSON.stringify(profile)}`,
    `Original resume text:\n${originalText || ''}`,
    fitted ? `LENGTH TEMPLATE (a version of this resume that fills its page exactly; a guide to size, not to wording):\n${JSON.stringify(normalizeStructured(fitted))}` : '',
    detectedBlock,
    jobBlock,
  ].filter(Boolean).join('\n\n');
  const out = await ask(prompt, shape);
  const structured = normalizeStructured(out.structured);
  const ats = normalizeAts(out.ats, problems);
  return { structured, ats };
}

// condenseStructured({ structured, profile, pages, targetPages }) -> structured
// Asks the LLM to shorten the resume so it fits targetPages, keeping every role and every fact.
export async function condenseStructured({ structured, profile, pages, targetPages, overflowLines = 0, totalLines = 0 }) {
  const shape = `{"structured": ${STRUCTURED_SHAPE}}`;
  const target = overflowLines + 2;
  const pct = totalLines ? Math.round((target / totalLines) * 100) : 15;
  const prompt = [
    `This resume renders to ${pages} page(s) at the tightest layout but must fit on ${targetPages} page(s). It is ${overflowLines} lines too long (each line is about 110 characters). Remove roughly ${target} lines of text in total, about ${pct} percent, and no more than that: the final page should be full, not sparse. Order of cuts: first shorten the wordiest bullets and the summary, then merge bullets that repeat each other, then trim the longest skill lines and the coursework list (never below 8 coursework items), and only as a last resort drop a whole bullet (never a role, project, or degree). Keep every skill category that has entries. Keep every date and number. Publications are never reworded and are the last thing to cut (newest and first-author ones stay); awards and volunteer lines may be dropped whole, smallest and oldest first, before any experience bullet is lost.`,
    `Candidate profile (source of truth facts):\n${JSON.stringify(profile)}`,
    `Current structured resume:\n${JSON.stringify(structured)}`,
  ].join('\n\n');
  const out = await ask(prompt, shape);
  return normalizeStructured(out.structured);
}
