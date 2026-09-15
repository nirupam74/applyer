import admin from 'firebase-admin';
import { emptyProfile } from './resume/extract.js';
import { sources, openBrowser } from './sources/index.js';
import { sleep } from './sources/browser.js';
import { analyzeBatch, buildQueries, finalScore, heuristicScore, jobId, mergeJob } from './rank.js';

const FieldValue = admin.firestore.FieldValue;
const TOP_N = 100;
const BLOCKED_COOLDOWN_MS = 24 * 3600e3; // a source that was blocked is left alone for a day

// searchJobs payload { sources?: string[], pagesPerQuery?, detailLimit?, analyzeLimit? }
export async function searchJobs({ db, uid, log }, payload) {
  const userRef = db.collection('users').doc(uid);
  const profileSnap = await userRef.collection('profile').doc('profile').get();
  const profile = profileSnap.exists ? profileSnap.data() : emptyProfile();

  const { titles, location } = buildQueries(profile);
  if (!titles.length) throw new Error('profile has no preferred titles or experience to search from');
  const pagesPerQuery = payload.pagesPerQuery || 2;
  const wanted = (payload.sources && payload.sources.length ? payload.sources : Object.keys(sources)).filter((s) => sources[s]);
  await log(`${titles.length} queries in "${location}": ${titles.join(' | ')}`);

  // 1. Scrape. Each source gets a run doc with status ok | blocked | error.
  const found = new Map(); // jobId -> merged job
  const jobs = new Map(); // jobId -> job after merging with stored docs
  const runs = {};
  const context = await openBrowser();
  try {
    for (const name of wanted) {
      const adapter = sources[name];
      const runRef = userRef.collection('sourceRuns').doc(name);
      const last = (await runRef.get()).data();
      if (last && last.status === 'blocked' && last.finishedAt && Date.now() - last.finishedAt.toMillis() < BLOCKED_COOLDOWN_MS) {
        runs[name] = { status: 'skipped', message: 'blocked on the last run', jobsFound: 0 };
        await log(`${name}: skipped, blocked ${Math.round((Date.now() - last.finishedAt.toMillis()) / 3600e3)} h ago`);
        continue;
      }
      await runRef.set({ status: 'running', startedAt: FieldValue.serverTimestamp(), message: '', jobsFound: 0 }, { merge: true });
      let status = 'ok';
      let message = '';
      let count = 0;
      outer: for (const query of titles) {
        for (let page = 0; page < pagesPerQuery; page++) {
          let res;
          try {
            res = await adapter.search({ query, location, page }, context);
          } catch (err) {
            res = { jobs: [], status: 'error', message: err.message };
          }
          for (const job of res.jobs) {
            const id = jobId(job);
            found.set(id, mergeJob(found.get(id), job));
            count++;
          }
          if (res.status !== 'ok') {
            status = res.status;
            message = res.message || '';
            await log(`${name}: ${status} on "${query}" p${page + 1}: ${message}`);
            break outer;
          }
          if (res.jobs.length < 5) break; // last page for this query
          await sleep(1200 + Math.random() * 800);
        }
      }
      runs[name] = { status, message, jobsFound: count };
      await runRef.set({ status, message, jobsFound: count, finishedAt: FieldValue.serverTimestamp() }, { merge: true });
      await log(`${name}: ${status}, ${count} listings`);
    }

    // 2. Merge with what is already stored so saved/dismissed/analysis survive.
    const existingSnap = await userRef.collection('jobs').get();
    const existing = new Map(existingSnap.docs.map((d) => [d.id, d.data()]));
    for (const [id, fresh] of found) {
      const prev = existing.get(id);
      const merged = prev ? mergeFresh(prev, fresh) : { ...fresh, status: 'new', matchPct: null, analysis: null, discoveredAt: new Date() };
      jobs.set(id, { id, ...merged });
    }
    for (const [id, prev] of existing) if (!jobs.has(id)) jobs.set(id, { id, ...prev });
    await log(`${found.size} unique listings this run, ${jobs.size} total after merge`);

    // 3. Heuristic score, then descriptions for the strongest candidates.
    for (const job of jobs.values()) job.heuristic = heuristicScore(job, profile);
    const ordered = [...jobs.values()].sort((a, b) => b.heuristic - a.heuristic);
    const detailLimit = payload.detailLimit || 120;
    const needDetails = ordered.slice(0, detailLimit).filter((j) => !j.description && j.externalIds && !j.detailsBlocked);
    await log(`fetching descriptions for ${needDetails.length} listings`);
    let fetched = 0;
    for (const job of needDetails) {
      if (job.detailsBlocked) continue;
      const [name, externalId] = Object.entries(job.externalIds)[0];
      const adapter = sources[name];
      if (!adapter || !adapter.details) continue;
      try {
        const src = job.sources.find((s) => s.name === name) || {};
        const tmp = { externalId, url: src.url, applyUrl: src.applyUrl, description: '' };
        await adapter.details(tmp, context);
        if (tmp.detailsBlocked) {
          job.detailsBlocked = true;
          await log(`${name}: blocked while fetching details, stopping detail fetches for this source`);
          needDetails.forEach((j) => { if (Object.keys(j.externalIds)[0] === name) j.detailsBlocked = true; });
          continue;
        }
        if (tmp.description) job.description = tmp.description;
        if (tmp.employmentType) job.employmentType = tmp.employmentType;
        if (tmp.seniority) job.seniority = tmp.seniority;
        if (tmp.postedAt && !job.postedAt) job.postedAt = tmp.postedAt;
        if (tmp.salary && !job.salary) job.salary = tmp.salary;
        if (tmp.applyUrl && tmp.applyUrl !== src.applyUrl) src.applyUrl = tmp.applyUrl;
        job.heuristic = heuristicScore(job, profile);
        fetched++;
        if (fetched % 10 === 0) await log(`descriptions: ${fetched}/${needDetails.length}`);
      } catch (err) {
        await log(`${name}: details failed for ${externalId}: ${err.message}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  // 4. LLM analysis in batches of 10 for the top candidates without one.
  const analyzeLimit = payload.analyzeLimit || 120;
  const ranked = [...jobs.values()].sort((a, b) => b.heuristic - a.heuristic);
  const toAnalyze = ranked.slice(0, analyzeLimit).filter((j) => !j.analysis);
  await log(`analyzing ${toAnalyze.length} listings with the LLM in batches of 10`);
  for (let i = 0; i < toAnalyze.length; i += 10) {
    const batch = toAnalyze.slice(i, i + 10);
    try {
      const results = await analyzeBatch(batch, profile);
      let got = 0;
      for (const job of batch) {
        const a = results[job.id];
        if (!a) continue;
        job.analysis = a;
        job.matchPct = a.matchPct;
        got++;
      }
      await log(`batch ${i / 10 + 1}/${Math.ceil(toAnalyze.length / 10)}: ${got}/${batch.length} analyzed`);
    } catch (err) {
      await log(`batch ${i / 10 + 1} failed: ${err.message}`);
    }
  }

  // 5. Final score and rank, then write everything.
  const all = [...jobs.values()];
  for (const job of all) job.score = finalScore(job.heuristic, job.matchPct);
  all.sort((a, b) => b.score - a.score || (b.matchPct || 0) - (a.matchPct || 0));
  let r = 0;
  for (const job of all) job.rank = job.status === 'dismissed' ? null : ++r <= TOP_N ? r : null;

  let batch = db.batch();
  let n = 0;
  for (const job of all) {
    const { id, ...data } = job;
    data.updatedAt = FieldValue.serverTimestamp();
    batch.set(userRef.collection('jobs').doc(id), data, { merge: true });
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  await log(`wrote ${all.length} jobs, top ${Math.min(TOP_N, r)} ranked`);

  return {
    runs,
    unique: found.size,
    total: all.length,
    analyzed: all.filter((j) => j.analysis).length,
    top: all.filter((j) => j.rank).slice(0, 5).map((j) => `${j.rank}. ${j.title} @ ${j.company} (${j.score})`),
  };
}

// Existing doc + fresh scrape: keep user state and analysis, refresh listing facts.
function mergeFresh(prev, fresh) {
  const out = { ...prev };
  for (const s of fresh.sources) if (!out.sources.some((x) => x.name === s.name)) out.sources = [...out.sources, s];
  out.externalIds = { ...(prev.externalIds || {}), ...(fresh.externalIds || {}) };
  if ((fresh.description || '').length > (prev.description || '').length) out.description = fresh.description;
  if (!out.salary && fresh.salary) out.salary = fresh.salary;
  if (!out.postedAt && fresh.postedAt) out.postedAt = fresh.postedAt;
  if ((!out.workMode || out.workMode === 'unknown') && fresh.workMode) out.workMode = fresh.workMode;
  if (!out.employmentType && fresh.employmentType) out.employmentType = fresh.employmentType;
  out.lastSeenAt = new Date();
  return out;
}
