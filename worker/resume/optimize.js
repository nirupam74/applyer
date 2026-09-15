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
  "skills": {"technical": string[], "tools": string[], "programming": string[], "marketing": string[], "business": string[], "communication": string[], "leadership": string[], "creative": string[], "industry": string[], "certifications": string[], "languages": string[]}
}`;

const SECTIONS = ['summary', 'education', 'experience', 'projects', 'skills'];

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

// optimizeResume({ profile, originalText, existingStructured, section }) -> { structured, ats }
export async function optimizeResume({ profile, originalText, existingStructured, section }) {
  if (section && !SECTIONS.includes(section)) {
    throw new Error(`Unknown section: ${section}`);
  }

  const problems = detectProblems({ profile, originalText, structured: existingStructured });
  const detectedBlock = problems.length
    ? `Detected problems (fold these, worded naturally, into ats.problems):\n${problems.map((p) => `- ${p}`).join('\n')}`
    : 'No deterministic problems were detected.';

  const base = existingStructured ? normalizeStructured(existingStructured) : emptyStructured();

  if (section) {
    const shape = `{"${section}": <the "${section}" field of ${STRUCTURED_SHAPE}>, "ats": ${ATS_SHAPE}}`;
    const prompt = [
      `Regenerate only the "${section}" section of an ATS-optimized resume. Keep every other section as-is; do not return them. The new "${section}" must be a materially improved rewrite, not a copy of the existing one.`,
      `Candidate profile (source of truth facts):\n${JSON.stringify(profile)}`,
      `Original resume text:\n${originalText || ''}`,
      `Existing structured resume for context:\n${JSON.stringify(base)}`,
      detectedBlock,
    ].join('\n\n');
    const out = await ask(prompt, shape);
    const structured = { ...base, [section]: normalizeSection(section, out[section]) };
    const ats = normalizeAts(out.ats, problems);
    return { structured, ats };
  }

  const shape = `{"structured": ${STRUCTURED_SHAPE}, "ats": ${ATS_SHAPE}}`;
  const prompt = [
    'Produce a full ATS-optimized resume, structured by section, plus an ATS report. Every experience entry must carry all of its bullets from the profile, rewritten to be achievement-focused; never drop a role or a bullet. Achievements must not restate a responsibility bullet: a result belongs either in the bullet or in achievements, never both.',
    `Candidate profile (source of truth facts):\n${JSON.stringify(profile)}`,
    `Original resume text:\n${originalText || ''}`,
    detectedBlock,
  ].join('\n\n');
  const out = await ask(prompt, shape);
  const structured = normalizeStructured(out.structured);
  const ats = normalizeAts(out.ats, problems);
  return { structured, ats };
}

// condenseStructured({ structured, profile, pages, targetPages }) -> structured
// Asks the LLM to shorten the resume so it fits targetPages, keeping every role and every fact.
export async function condenseStructured({ structured, profile, pages, targetPages }) {
  const shape = `{"structured": ${STRUCTURED_SHAPE}}`;
  const prompt = [
    `This resume renders to ${pages} page(s) but must fit on ${targetPages} page(s). Condense it: tighten every bullet to one line where possible, merge overlapping bullets, cap each role at 3-4 bullets (keep the strongest, metric-bearing ones), shorten the summary to 40-60 words, keep at most 8 coursework items, and trim skills to the strongest 5-7 per category, keeping at most 5 skill categories (fold the rest into the closest kept category, leaving the others as empty arrays). Keep every role, project, degree, date, and number. Do not add anything.`,
    `Candidate profile (source of truth facts):\n${JSON.stringify(profile)}`,
    `Current structured resume:\n${JSON.stringify(structured)}`,
  ].join('\n\n');
  const out = await ask(prompt, shape);
  return normalizeStructured(out.structured);
}
