import admin from 'firebase-admin';
import { bytesToText } from './resume/parse.js';
import { extractProfile, emptyProfile } from './resume/extract.js';
import { optimizeResume as runOptimize } from './resume/optimize.js';
import { buildDocx } from './resume/docx.js';

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

  await log('building DOCX');
  const docxBuffer = await buildDocx(structured, profile.personal || {});

  const data = {
    resumeId,
    label: (existing && existing.label) || 'Optimized from ' + (resume.name || 'resume'),
    structured,
    ats,
    docxBytes: docxBuffer,
    createdAt: (existing && existing.createdAt) || FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await versionRef.set(data, { merge: true });
  await log('version saved');

  return { versionId: versionRef.id };
}

export const handlers = { parseResume, optimizeResume };
