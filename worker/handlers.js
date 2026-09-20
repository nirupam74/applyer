import admin from 'firebase-admin';
import { bytesToText } from './resume/parse.js';
import { extractProfile, emptyProfile } from './resume/extract.js';
import { optimizeResume as runOptimize } from './resume/optimize.js';
import { buildDocx, FIT_LEVELS } from './resume/docx.js';
import { docxToPdf } from './resume/pdf.js';
import { condenseStructured } from './resume/optimize.js';
import { searchJobs } from './search.js';
import { prepareDocuments, prepareBatch } from './apply/documents.js';
import { assistant } from './assistant.js';
import { applyToJob, applyBatch } from './apply/agent.js';

const FieldValue = admin.firestore.FieldValue;

function isEmptyValue(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

// Deep-merge extracted onto current, only filling fields that are currently empty
// unless overwrite is true.
function mergeProfile(current, extracted, overwrite) {
  if (Array.isArray(extracted)) {
    if (overwrite) return extracted;
    return isEmptyValue(current) ? extracted : current;
  }
  if (extracted !== null && typeof extracted === 'object') {
    const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const out = { ...base };
    for (const key of Object.keys(extracted)) {
      out[key] = mergeProfile(base[key], extracted[key], overwrite);
    }
    return out;
  }
  if (overwrite) return extracted;
  return isEmptyValue(current) ? extracted : current;
}

function countFilledFields(profile) {
  let count = 0;
  const visit = (v) => {
    if (Array.isArray(v)) {
      if (v.length) count++;
      v.forEach(visit);
    } else if (v !== null && typeof v === 'object') {
      Object.values(v).forEach(visit);
    } else if (!isEmptyValue(v)) {
      count++;
    }
  };
  visit(profile);
  return count;
}

// parseResume payload { resumeId, overwrite? }
export async function parseResume({ db, uid, log }, payload) {
  const { resumeId, overwrite } = payload;
  if (!resumeId) throw new Error('parseResume requires payload.resumeId');

  const userRef = db.collection('users').doc(uid);
  const resumeRef = userRef.collection('resumes').doc(resumeId);

  await log(`loading resume ${resumeId}`);
  const resumeSnap = await resumeRef.get();
  if (!resumeSnap.exists) throw new Error(`resume ${resumeId} not found`);
  const resume = resumeSnap.data();

  await log('extracting text from file');
  const text = await bytesToText(resume.bytes, resume.mime);
  await resumeRef.update({ text });

  await log('calling LLM to extract profile');
  const extracted = await extractProfile(text);

  const profileRef = userRef.collection('profile').doc('profile');
  const profileSnap = await profileRef.get();
  const current = profileSnap.exists ? profileSnap.data() : emptyProfile();

  const merged = mergeProfile(current, extracted, overwrite === true);
  merged.updatedAt = FieldValue.serverTimestamp();
  await profileRef.set(merged, { merge: true });
  await log('profile updated');

  return { profileFields: countFilledFields(extracted) };
}

// optimizeResume payload { resumeId, versionId?, section? }
export async function optimizeResume({ db, uid, log }, payload) {
  const { resumeId, versionId, section } = payload;
  if (!resumeId) throw new Error('optimizeResume requires payload.resumeId');

  const userRef = db.collection('users').doc(uid);
  const resumeRef = userRef.collection('resumes').doc(resumeId);

  await log(`loading resume ${resumeId}`);
  const resumeSnap = await resumeRef.get();
  if (!resumeSnap.exists) throw new Error(`resume ${resumeId} not found`);
  const resume = resumeSnap.data();

  const profileRef = userRef.collection('profile').doc('profile');
  const profileSnap = await profileRef.get();
  const profile = profileSnap.exists ? profileSnap.data() : emptyProfile();

  const versionsCol = userRef.collection('resumeVersions');
  const versionRef = versionId ? versionsCol.doc(versionId) : versionsCol.doc();
  const existingSnap = versionId ? await versionRef.get() : null;
  const existing = existingSnap && existingSnap.exists ? existingSnap.data() : null;

  await log(section ? `regenerating section ${section}` : 'generating optimized resume');
  const { structured, ats } = await runOptimize({
    profile,
    originalText: resume.text || '',
    existingStructured: existing ? existing.structured : undefined,
    section,
  });

  const settingsSnap = await userRef.collection('settings').doc('resume').get();
  const pageLimit = Number(settingsSnap.exists && settingsSnap.data().maxPages) || 1;
  const fitted = await fitToPages({ structured, profile, pageLimit, log });
  const docxBuffer = fitted.docx;
  Object.assign(structured, fitted.structured);

  const data = {
    resumeId,
    label: (existing && existing.label) || 'Optimized from ' + (resume.name || 'resume'),
    structured,
    ats,
    docxBytes: docxBuffer,
    pdfBytes: fitted.pdf,
    pages: fitted.pages,
    pageLimit,
    fits: fitted.pages <= pageLimit,
    fileName: `${(profile.personal && profile.personal.name) || 'Resume'} - Resume`,
    createdAt: (existing && existing.createdAt) || FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await versionRef.set(data, { merge: true });
  await log('version saved');

  return { versionId: versionRef.id };
}

export const handlers = { parseResume, optimizeResume, searchJobs, prepareDocuments, prepareBatch, applyToJob, applyBatch, assistant };

// fitToPages: build DOCX, render to PDF, and shrink (layout levels, then LLM condensing)
// until the real page count is within pageLimit. Returns the best attempt if nothing fits.
export async function fitToPages({ structured, profile, pageLimit, log }) {
  const personal = profile.personal || {};
  const opts = { availability: profile.availability || '' };
  let current = structured;
  let best = null;
  let last = null;
  for (let round = 0; round < 4; round++) {
    for (let level = 0; level < FIT_LEVELS.length; level++) {
      await log(`building DOCX (round ${round + 1}, layout level ${level + 1})`);
      const docx = await buildDocx(current, personal, { ...opts, level });
      const { pdf, pages, linesPerPage } = await docxToPdf(docx);
      await log(`rendered ${pages} page(s), limit ${pageLimit}`);
      const attempt = { docx, pdf, pages, linesPerPage, structured: current, level, round };
      last = attempt;
      if (!best || pages < best.pages) best = attempt;
      if (pages <= pageLimit) return round === 0 ? attempt : refill({ attempt, structured, profile, pageLimit, log, opts, personal });
    }
    if (round < 3) {
      const lines = last.linesPerPage || [];
      const overflowLines = lines.slice(pageLimit).reduce((a, b) => a + b, 0);
      const totalLines = lines.reduce((a, b) => a + b, 0);
      await log(`still too long by ${overflowLines} lines, condensing content with the LLM`);
      current = await condenseStructured({ structured: current, profile, pages: last.pages, targetPages: pageLimit, overflowLines, totalLines });
    }
  }
  await log(`could not fit within ${pageLimit} page(s); keeping the shortest version (${best.pages} pages)`);
  return best;
}

// refill: after LLM condensing, put profile items back one at a time (coursework, then skills)
// and re-render after each, stopping right before the page limit is exceeded. Deterministic,
// about one second per item, so the page ends up full instead of sparse.
async function refill({ attempt, structured: original, profile, pageLimit, log, opts, personal }) {
  const current = JSON.parse(JSON.stringify(attempt.structured));
  const candidates = [];
  (original.education || []).forEach((ed, i) => {
    const have = new Set((current.education[i]?.coursework) || []);
    for (const c of ed.coursework || []) if (!have.has(c)) candidates.push({ kind: 'course', i, value: c });
  });
  const skills = original.skills || {};
  for (const cat of Object.keys(skills)) {
    const have = new Set(current.skills?.[cat] || []);
    for (const s of skills[cat] || []) if (!have.has(s)) candidates.push({ kind: 'skill', cat, value: s });
  }
  if (!candidates.length) return attempt;
  await log(`page has room, refilling from ${candidates.length} profile items`);
  let best = attempt;
  let added = 0;
  for (const c of candidates.slice(0, 40)) {
    const trial = JSON.parse(JSON.stringify(best.structured));
    if (c.kind === 'course') {
      if (!trial.education[c.i]) continue;
      trial.education[c.i].coursework = [...(trial.education[c.i].coursework || []), c.value];
    } else {
      trial.skills = trial.skills || {};
      trial.skills[c.cat] = [...(trial.skills[c.cat] || []), c.value];
    }
    const docx = await buildDocx(trial, personal, { ...opts, level: best.level });
    const { pdf, pages, linesPerPage } = await docxToPdf(docx);
    if (pages > pageLimit) {
      if (c.kind === 'course') continue; // a long course name may not fit where a short skill still does
      break;
    }
    best = { ...best, docx, pdf, pages, linesPerPage, structured: trial };
    added++;
  }
  await log(`refilled ${added} item(s); ${best.pages} page(s)`);
  return best;
}

// Same type + payload as a task that was still unfinished when this one was created (a second
// press of Search now while the first search runs): nothing new to do.
export function isRepeat(task, others) {
  const made = task.createdAt?.toMillis?.() || 0;
  const key = JSON.stringify(task.payload || {});
  return others.some(
    (o) => o.id !== task.id && o.type === task.type && JSON.stringify(o.payload || {}) === key &&
      (o.createdAt?.toMillis?.() || 0) <= made && o.status !== 'failed' && (o.status !== 'done' || (o.updatedAt?.toMillis?.() || 0) > made),
  );
}
