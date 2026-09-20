import { ask } from '../llm.js';

export function coerceString(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

export function coerceArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

export function coerceStringArray(v) {
  return coerceArray(v).map(coerceString);
}

export function normalizePersonal(input) {
  const p = input || {};
  return {
    name: coerceString(p.name),
    email: coerceString(p.email),
    phone: coerceString(p.phone),
    location: coerceString(p.location),
    linkedin: coerceString(p.linkedin),
    portfolio: coerceString(p.portfolio),
    website: coerceString(p.website),
    links: coerceStringArray(p.links),
  };
}

export function normalizeEducationItem(item) {
  const e = item || {};
  return {
    institution: coerceString(e.institution),
    degree: coerceString(e.degree),
    program: coerceString(e.program),
    major: coerceString(e.major),
    minor: coerceString(e.minor),
    gpa: coerceString(e.gpa),
    graduation: coerceString(e.graduation),
    coursework: coerceStringArray(e.coursework),
  };
}

export function normalizeExperienceItem(item) {
  const e = item || {};
  return {
    company: coerceString(e.company),
    title: coerceString(e.title),
    employmentType: coerceString(e.employmentType),
    start: coerceString(e.start),
    end: coerceString(e.end),
    responsibilities: coerceStringArray(e.responsibilities),
    achievements: coerceStringArray(e.achievements),
    metrics: coerceStringArray(e.metrics),
    technologies: coerceStringArray(e.technologies),
    skills: coerceStringArray(e.skills),
    industry: coerceString(e.industry),
  };
}

export function normalizeProjectItem(item) {
  const p = item || {};
  return {
    name: coerceString(p.name),
    description: coerceString(p.description),
    technologies: coerceStringArray(p.technologies),
    link: coerceString(p.link),
  };
}

export function normalizeSkills(input) {
  const s = input || {};
  return {
    technical: coerceStringArray(s.technical),
    tools: coerceStringArray(s.tools),
    programming: coerceStringArray(s.programming),
    marketing: coerceStringArray(s.marketing),
    business: coerceStringArray(s.business),
    communication: coerceStringArray(s.communication),
    leadership: coerceStringArray(s.leadership),
    creative: coerceStringArray(s.creative),
    industry: coerceStringArray(s.industry),
    certifications: coerceStringArray(s.certifications),
    languages: coerceStringArray(s.languages),
  };
}

const REMOTE_VALUES = ['remote', 'hybrid', 'onsite', 'any'];

export function normalizePreferences(input) {
  const p = input || {};
  return {
    titles: coerceStringArray(p.titles),
    industries: coerceStringArray(p.industries),
    locations: coerceStringArray(p.locations),
    remote: REMOTE_VALUES.includes(p.remote) ? p.remote : 'any',
    employmentType: coerceStringArray(p.employmentType),
    salaryMin: typeof p.salaryMin === 'number' ? p.salaryMin : null,
    seniority: coerceString(p.seniority),
  };
}

// emptyProfile() with every field present, matching the Profile contract exactly.
export function normalizeProfile(input) {
  const p = input || {};
  return {
    personal: normalizePersonal(p.personal),
    education: coerceArray(p.education).map(normalizeEducationItem),
    experience: coerceArray(p.experience).map(normalizeExperienceItem),
    projects: coerceArray(p.projects).map(normalizeProjectItem),
    // Academic and research CVs: each entry is one line, kept as written.
    publications: coerceStringArray(p.publications),
    awards: coerceStringArray(p.awards),
    volunteer: coerceStringArray(p.volunteer),
    skills: normalizeSkills(p.skills),
    preferences: normalizePreferences(p.preferences),
    workAuthorization: coerceString(p.workAuthorization),
    availability: coerceString(p.availability),
    updatedAt: p.updatedAt ?? null,
  };
}

export function emptyProfile() {
  return normalizeProfile({});
}

const PROFILE_SHAPE = `{
  "personal": {"name": string, "email": string, "phone": string, "location": string, "linkedin": string, "portfolio": string, "website": string, "links": string[]},
  "education": [{"institution": string, "degree": string, "program": string, "major": string, "minor": string, "gpa": string, "graduation": string, "coursework": string[]}],
  "experience": [{"company": string, "title": string, "employmentType": string, "start": string, "end": string, "responsibilities": string[], "achievements": string[], "metrics": string[], "technologies": string[], "skills": string[], "industry": string}],
  "projects": [{"name": string, "description": string, "technologies": string[], "link": string}],
  "publications": string[] (one full citation per entry, copied as written, including manuscripts in preparation or under review),
  "awards": string[] (one line per honour, award, scholarship, certification or licence, with its year),
  "volunteer": string[] (one line per volunteer role or activity: role, organisation, dates),
  "skills": {"technical": string[], "tools": string[], "programming": string[], "marketing": string[], "business": string[], "communication": string[], "leadership": string[], "creative": string[], "industry": string[], "certifications": string[], "languages": string[]},
  "preferences": {"titles": string[], "industries": string[], "locations": string[], "remote": "remote"|"hybrid"|"onsite"|"any", "employmentType": string[], "salaryMin": number|null, "seniority": string},
  "workAuthorization": string,
  "availability": string,
  "missing": string[]
}`;

// extractProfile(text) -> Profile, via one LLM call, normalized so every key is present.
export async function extractProfile(text) {
  const prompt = `Extract a structured candidate profile from the resume text below. Only use facts stated in the text.\nSkills: include every skill explicitly listed, plus skills that the described experience and projects clearly demonstrate (for example a role that ran Instagram campaigns demonstrates social media marketing; building an app in Swift demonstrates iOS development). Put each inferred skill in the most fitting category and also in the skills array of the role that demonstrates it. Never infer employers, titles, dates, degrees, certifications, or numbers.\n\nResume text:\n${text}`;
  const raw = await ask(prompt, PROFILE_SHAPE);
  return normalizeProfile(raw);
}
