import { Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat } from 'docx';

const FONT = 'Calibri'; // ponytail: true font fallback chains are not a DOCX concept; Calibri
// is the primary and Word/mammoth substitute Arial automatically when Calibri is unavailable.
const BODY_SIZE = 22; // 11pt in half-points
const NAME_SIZE = 32; // 16pt, the only large heading
const HEADING_SIZE = 24; // 12pt

const BULLETS_REF = 'applyer-bullets';

function bulletParagraph(text) {
  return new Paragraph({
    numbering: { reference: BULLETS_REF, level: 0 },
    children: [new TextRun({ text, font: FONT, size: BODY_SIZE })],
  });
}

function bodyParagraph(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text, font: FONT, size: BODY_SIZE, bold: !!opts.bold })],
  });
}

function sectionHeading(text) {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: text.toUpperCase(), font: FONT, size: HEADING_SIZE, bold: true })],
  });
}

function contactLine(personal) {
  const parts = [personal.email, personal.phone, personal.location, personal.linkedin].filter(Boolean);
  return bodyParagraph(parts.join(' | '));
}

// buildDocx(structured, personal) -> Buffer. Single column, no tables, no images,
// Calibri 11pt, name as the only large heading, caps section headings, real numbering bullets.
export function buildDocx(structured, personal = {}) {
  const children = [];

  children.push(
    new Paragraph({
      children: [new TextRun({ text: personal.name || '', font: FONT, size: NAME_SIZE, bold: true })],
    })
  );
  children.push(contactLine(personal));

  if (structured.summary) {
    children.push(sectionHeading('Summary'));
    children.push(bodyParagraph(structured.summary));
  }

  if (structured.experience && structured.experience.length) {
    children.push(sectionHeading('Experience'));
    for (const role of structured.experience) {
      const titleLine = [role.title, role.company].filter(Boolean).join(', ');
      const dateLine = [role.start, role.end].filter(Boolean).join(' - ');
      children.push(bodyParagraph([titleLine, dateLine].filter(Boolean).join('  '), { bold: true }));
      for (const bullet of [...(role.responsibilities || []), ...(role.achievements || [])]) {
        children.push(bulletParagraph(bullet));
      }
    }
  }

  if (structured.education && structured.education.length) {
    children.push(sectionHeading('Education'));
    for (const edu of structured.education) {
      const line = [edu.degree, edu.institution, edu.graduation].filter(Boolean).join(', ');
      children.push(bodyParagraph(line));
    }
  }

  if (structured.projects && structured.projects.length) {
    children.push(sectionHeading('Projects'));
    for (const project of structured.projects) {
      children.push(bodyParagraph(project.name, { bold: true }));
      if (project.description) children.push(bodyParagraph(project.description));
    }
  }

  if (structured.skills) {
    const skillLines = Object.entries(structured.skills)
      .filter(([, list]) => Array.isArray(list) && list.length)
      .map(([, list]) => list.join(', '));
    if (skillLines.length) {
      children.push(sectionHeading('Skills'));
      children.push(bodyParagraph(skillLines.join(' | ')));
    }
  }

  const doc = new Document({
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
              style: { paragraph: { indent: { left: 360, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
