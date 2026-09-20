import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  LevelFormat,
  BorderStyle,
  TabStopType,
  TabStopPosition,
} from 'docx';

const FONT = 'Calibri'; // ponytail: DOCX has no fallback chains; Word substitutes Arial when Calibri is missing.
const BULLETS_REF = 'applyer-bullets';

// Fit levels: the handler walks down this list until the rendered PDF fits the user's page limit.
// Sizes are half-points, spacing/margins are twips (1440 = 1 inch).
export const FIT_LEVELS = [
  { body: 22, name: 32, heading: 22, after: 60, sectionBefore: 160, margin: 1008 },
  { body: 21, name: 30, heading: 21, after: 40, sectionBefore: 120, margin: 864 },
  { body: 20, name: 28, heading: 20, after: 20, sectionBefore: 100, margin: 720 },
];

function runs(parts, L) {
  return parts.map((p) => new TextRun({ text: p.text, font: FONT, size: p.size || L.body, bold: !!p.bold }));
}

function bullet(text, L) {
  return new Paragraph({
    numbering: { reference: BULLETS_REF, level: 0 },
    spacing: { after: 0 },
    children: runs([{ text }], L),
  });
}

function centered(parts, L, after) {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after }, children: runs(parts, L) });
}

function heading(text, L) {
  return new Paragraph({
    spacing: { before: L.sectionBefore, after: 40 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
    children: runs([{ text: text.toUpperCase(), bold: true, size: L.heading }], L),
  });
}

// "Bold title  |  regular subtitle" on the left, bold dates flush right via a right tab stop.
function entryLine(title, subtitle, dates, L) {
  const parts = [{ text: title, bold: true }];
  if (subtitle) parts.push({ text: `  |  ${subtitle}` });
  if (dates) parts.push({ text: `\t${dates}`, bold: true });
  return new Paragraph({
    spacing: { before: L.after + 40, after: 20 },
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: runs(parts, L),
  });
}

// Two bullets are duplicates when they share at least half of the shorter one's distinct words.
function overlaps(a, b) {
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  const ratio = shared / Math.min(A.size, B.size);
  const sameOpening = [...A][0] === [...B][0];
  return ratio >= 0.5 || (sameOpening && ratio >= 0.35);
}

// Drop skill entries that repeat an earlier entry's first 20 normalized characters (e.g. two "AI-assisted development (...)" variants).
function dedupeSkills(list) {
  const seen = new Set();
  return list.filter((s) => {
    const k = s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dateRange(start, end) {
  return [start, end].filter(Boolean).join(' - ');
}

const SKILL_LABELS = {
  research: 'Research',
  laboratory: 'Laboratory',
  marketing: 'Marketing',
  creative: 'Design & content',
  technical: 'Technical',
  programming: 'Development',
  tools: 'Tools',
  business: 'Business',
  communication: 'Communication',
  leadership: 'Leadership',
  industry: 'Industry',
  certifications: 'Certifications',
  languages: 'Languages',
};

// buildDocx(structured, personal, opts) -> Promise<Buffer>.
// Layout mirrors the user's reference resume: centered name + contact lines, ruled caps headings,
// "Title | Company" entries with right-aligned dates, bullets, skills grouped per line.
// Single column, no tables, no images (ATS-safe). opts.level picks a FIT_LEVELS entry.
export function buildDocx(structured, personal = {}, opts = {}) {
  const L = FIT_LEVELS[Math.min(opts.level || 0, FIT_LEVELS.length - 1)];
  const children = [];

  children.push(centered([{ text: (personal.name || '').toUpperCase(), bold: true, size: L.name }], L, 40));
  const line1 = [personal.email, personal.phone, personal.location].filter(Boolean);
  const line2 = [personal.website || personal.portfolio, personal.linkedin, opts.availability ? `Availability: ${opts.availability}` : '']
    .filter(Boolean);
  if (line1.length) children.push(centered([{ text: line1.join('  |  ') }], L, 0));
  if (line2.length) children.push(centered([{ text: line2.join('  |  ') }], L, 0));

  if (structured.summary) {
    children.push(heading('Professional summary', L));
    children.push(new Paragraph({ spacing: { after: L.after }, children: runs([{ text: structured.summary }], L) }));
  }

  if (structured.experience?.length) {
    children.push(heading('Relevant experience', L));
    for (const e of structured.experience) {
      children.push(entryLine(e.title, e.company, dateRange(e.start, e.end), L));
      // Merge achievements into responsibilities: an overlapping pair keeps the metric-bearing (or longer) text once.
      const resp = [...(e.responsibilities || [])];
      const extra = [];
      for (const a of e.achievements || []) {
        const i = resp.findIndex((r) => overlaps(r, a));
        if (i === -1) extra.push(a);
        else if (/\d/.test(a) && (!/\d/.test(resp[i]) || a.length > resp[i].length)) resp[i] = a;
      }
      for (const b of [...resp, ...extra]) children.push(bullet(b, L));
    }
  }

  if (structured.projects?.length) {
    children.push(heading('Projects', L));
    for (const p of structured.projects) {
      children.push(entryLine(p.name, p.technologies?.length ? p.technologies.join(', ') : '', p.link || '', L));
      if (p.description) children.push(bullet(p.description, L));
    }
  }

  for (const [key, title] of [['publications', 'Publications'], ['awards', 'Honours & Awards'], ['volunteer', 'Volunteer Experience']]) {
    if (!structured[key]?.length) continue;
    children.push(heading(title, L));
    for (const line of structured[key]) children.push(bullet(line, L));
  }

  if (structured.education?.length) {
    children.push(heading('Education', L));
    for (const ed of structured.education) {
      children.push(entryLine(ed.degree || ed.program, ed.institution, ed.graduation, L));
      const detail = [
        [ed.program, ed.major ? `specialization in ${ed.major}` : '', ed.minor ? `minor in ${ed.minor}` : ''].filter(Boolean).join(', '),
        ed.gpa ? `GPA ${ed.gpa}` : '',
      ].filter(Boolean).join('  |  ');
      if (detail) children.push(bullet(detail, L));
      if (ed.coursework?.length) children.push(bullet(`Relevant coursework: ${ed.coursework.join(', ')}`, L));
    }
  }

  const skills = structured.skills || {};
  const skillLines = Object.entries(SKILL_LABELS)
    .filter(([k]) => skills[k]?.length)
    .map(([k, label]) => `${label}: ${dedupeSkills(skills[k]).join('  |  ')}`);
  if (skillLines.length) {
    children.push(heading('Skills', L));
    for (const line of skillLines) children.push(bullet(line, L));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: L.body } } } },
    numbering: {
      config: [
        {
          reference: BULLETS_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 300, hanging: 200 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: L.margin, bottom: L.margin, left: L.margin, right: L.margin } } },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
