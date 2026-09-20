import admin from 'firebase-admin';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { emptyProfile, coerceString, coerceStringArray } from '../resume/extract.js';
import { optimizeResume as runOptimize } from '../resume/optimize.js';
import { docxToPdf } from '../resume/pdf.js';
import { ask } from '../llm.js';
import { fitToPages } from '../handlers.js';

const FieldValue = admin.firestore.FieldValue;
const COVER_FONT = 'Calibri';
const COVER_SIZE = 22; // 11pt in half-points

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[/\\]/g, '-');
}

// resolveApplicationEmail(profile, appSettings) -> string
// settings/applications.email, when present, replaces the profile email everywhere.
export function resolveApplicationEmail(profile, appSettings) {
  return (appSettings && appSettings.email) || (profile.personal && profile.personal.email) || '';
}

function coverParagraph(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 200 },
    children: [new TextRun({ text, font: COVER_FONT, size: COVER_SIZE, bold: !!opts.bold })],
  });
}

// buildCoverLetterDocx({ personal, company, date, paragraphs, closing }) -> Promise<Buffer>
// Pure rendering: name + contact block, date, greeting, body paragraphs, sign-off.
export function buildCoverLetterDocx({ personal = {}, company, date, paragraphs, closing }) {
  const children = [];
  children.push(coverParagraph(personal.name || '', { bold: true }));
  const contact = [personal.email, personal.phone, personal.location].filter(Boolean).join('  |  ');
  if (contact) children.push(coverParagraph(contact));
  children.push(coverParagraph(date));
  children.push(coverParagraph(`Dear Hiring Team at ${company},`));
  for (const para of paragraphs) children.push(coverParagraph(para));
  children.push(coverParagraph(closing));
  // Sign-off: "Sincerely,", an empty line, then the name on its own line.
  children.push(coverParagraph('Sincerely,'));
  children.push(coverParagraph(''));
  children.push(coverParagraph(personal.name || ''));
  const doc = new Document({
    styles: { default: { document: { run: { font: COVER_FONT, size: COVER_SIZE } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// prepareDocuments({ db, uid, log }, { jobId }) -> { resumeVersionId, coverLetterId, resumePath, coverPath, email }
// Builds a job-tailored resume version and a cover letter for one job, and writes both PDFs to
// disk for the browser agent to upload.
export async function prepareDocuments({ db, uid, log }, { jobId }) {
  if (!jobId) throw new Error('prepareDocuments requires payload.jobId');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new Error('invalid jobId');
  const userRef = db.collection('users').doc(uid);

  await log(`loading job ${jobId}`);
  const jobSnap = await userRef.collection('jobs').doc(jobId).get();
  if (!jobSnap.exists) throw new Error(`job ${jobId} not found`);
  const job = jobSnap.data();

  await log('loading profile and settings');
  const profileSnap = await userRef.collection('profile').doc('profile').get();
  let profile = profileSnap.exists ? profileSnap.data() : emptyProfile();

  const [appSettingsSnap, resumeSettingsSnap, resumesSnap] = await Promise.all([
    userRef.collection('settings').doc('applications').get(),
    userRef.collection('settings').doc('resume').get(),
    userRef.collection('resumes').orderBy('uploadedAt', 'desc').limit(1).get(),
  ]);

  if (resumesSnap.empty) throw new Error('no resume uploaded; upload a resume first');
  const resumeDoc = resumesSnap.docs[0];
  const resumeId = resumeDoc.id;
  const resume = resumeDoc.data();

  const applicationEmail = resolveApplicationEmail(profile, appSettingsSnap.exists ? appSettingsSnap.data() : null);
  profile = { ...profile, personal: { ...(profile.personal || {}), email: applicationEmail } };
  const name = profile.personal.name || 'Resume';

  const pageLimit = Number(resumeSettingsSnap.exists && resumeSettingsSnap.data().maxPages) || 1;

  // A version that already fits the page is the length template. Tailoring from the raw profile
  // overshot the page by about 13 lines every time and paid for 2-3 condensing rounds (3 minutes).
  // It only guides size (the facts come from the profile), so one older than the last profile edit
  // is fine: without any template a 2-page CV overshot by 48 lines and never got back under the limit.
  const recent = await userRef.collection('resumeVersions').orderBy('createdAt', 'desc').limit(30).select('structured', 'fits', 'pageLimit', 'createdAt', 'ats', 'jobId').get();
  const fitted = pickTemplate(recent.docs.map((d) => d.data()), pageLimit)?.structured;

  // The cover letter does not depend on the resume: both LLM calls run at once.
  await log(`tailoring resume${fitted ? ' (sized from the best fitting version)' : ''} and writing cover letter for ${job.title} at ${job.company}`);
  const analysis = job.analysis || {};
  const clShape = '{"paragraphs": string[] (3-4 paragraphs), "closing": string (one closing sentence before the sign-off)}';
  const clPrompt = [
    'Write a cover letter for this candidate applying to the target job below. 3 to 4 paragraphs plus one closing sentence. Do not include "Dear ..." or "Sincerely, ...", those are added separately.',
    `Candidate profile (source of truth facts):\n${JSON.stringify(profile)}`,
    `Target job:\nTitle: ${job.title}\nCompany: ${job.company}\nDescription:\n${job.description || ''}`,
    `Strengths to emphasize: ${JSON.stringify(analysis.strong || [])}`,
    `Candidate advantages to emphasize: ${JSON.stringify(analysis.advantages || [])}`,
  ].join('\n\n');
  const clPending = ask(clPrompt, clShape);
  clPending.catch(() => {}); // awaited below; a tailoring error must not leave this rejection unhandled

  const { structured, ats } = await runOptimize({
    profile,
    originalText: resume.text || '',
    job: { title: job.title, company: job.company, description: job.description },
    fitted,
  });

  const fit = await fitToPages({ structured, profile, pageLimit, log });
  Object.assign(structured, fit.structured);

  await log('saving tailored resume version');
  const versionRef = userRef.collection('resumeVersions').doc();
  await versionRef.set({
    resumeId,
    jobId,
    label: `Tailored for ${job.company} ${job.title}`,
    structured,
    ats,
    docxBytes: fit.docx,
    pdfBytes: fit.pdf,
    pages: fit.pages,
    pageLimit,
    fits: fit.pages <= pageLimit,
    fileName: `${name} - Resume`,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const clOut = await clPending;
  const paragraphs = coerceStringArray(clOut.paragraphs);
  const closing = coerceString(clOut.closing);

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const clDocx = await buildCoverLetterDocx({ personal: profile.personal, company: job.company, date, paragraphs, closing });
  const { pdf: clPdf } = await docxToPdf(clDocx);
  const clText = [`Dear Hiring Team at ${job.company},`, ...paragraphs, closing, 'Sincerely,', name].join('\n\n');

  await log('saving cover letter');
  const coverRef = userRef.collection('coverLetters').doc();
  const coverFileName = `${name} - Cover Letter`;
  await coverRef.set({
    jobId,
    resumeVersionId: versionRef.id,
    text: clText,
    docxBytes: clDocx,
    pdfBytes: clPdf,
    fileName: coverFileName,
    createdAt: FieldValue.serverTimestamp(),
  });

  await log('writing PDFs to disk');
  const dir = path.join(os.homedir(), '.applyer', 'applications', uid, jobId);
  await fs.mkdir(dir, { recursive: true });
  const resumePath = path.join(dir, `${sanitizeFileName(`${name} - Resume`)}.pdf`);
  const coverPath = path.join(dir, `${sanitizeFileName(coverFileName)}.pdf`);
  await fs.writeFile(resumePath, fit.pdf);
  await fs.writeFile(coverPath, clPdf);

  // The dashboard reads this to offer the downloads on the job itself (the user applies by hand).
  await userRef.collection('jobs').doc(jobId).update({ docs: { resumeVersionId: versionRef.id, coverLetterId: coverRef.id, preparedAt: FieldValue.serverTimestamp() } }).catch(() => {});

  return { resumeVersionId: versionRef.id, coverLetterId: coverRef.id, resumePath, coverPath, email: applicationEmail };
}

// The member's most optimised resume that fills the page limit: untailored before tailored,
// then the best ATS score, then the newest.
export function pickTemplate(versions, pageLimit) {
  const ms = (v) => v.createdAt?.toMillis?.() || 0;
  return versions
    .filter((v) => v.fits && v.pageLimit === pageLimit && v.structured)
    .sort((a, b) => !!a.jobId - !!b.jobId || (b.ats?.score || 0) - (a.ats?.score || 0) || ms(b) - ms(a))[0];
}

// prepareBatch({ db, uid, log }, { minScore?, limit? })
// Tailored resume + cover letter for every strong match that has none yet (or whose documents
// predate the last profile change), best first, one at a time: LibreOffice and the LLM CLI do not
// like company.
export async function prepareBatch({ db, uid, log }, payload = {}) {
  const userRef = db.collection('users').doc(uid);
  // The member's own bar (settings/jobs.prepareMinScore) applies to the button and to the batch every search queues.
  const minScore = payload.minScore || (await userRef.collection('settings').doc('jobs').get()).data()?.prepareMinScore || 80;
  const profileSnap = await userRef.collection('profile').doc('profile').get();
  const validFrom = profileSnap.data()?.updatedAt?.toMillis?.() || 0;
  const snap = await userRef.collection('jobs').where('score', '>=', minScore).orderBy('score', 'desc').get();
  const todo = snap.docs.filter((d) => {
    const j = d.data();
    return ['new', 'saved'].includes(j.status || 'new') && !((j.docs?.preparedAt?.toMillis?.() || 0) > validFrom);
  }).slice(0, payload.limit || 50);
  let prepared = 0; const failed = [];
  for (const d of todo) {
    await log(`documents ${prepared + failed.length + 1} of ${todo.length}: ${d.data().title} at ${d.data().company}`);
    try { await prepareDocuments({ db, uid, log }, { jobId: d.id }); prepared++; } catch (err) { failed.push(`${d.data().company}: ${err.message.split('\n')[0]}`); await log(`failed: ${err.message.split('\n')[0]}`); }
  }
  return { total: todo.length, prepared, failed };
}
