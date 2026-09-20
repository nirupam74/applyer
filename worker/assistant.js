import admin from 'firebase-admin';
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { apiKey, MODEL } from './llm.js';

const FieldValue = admin.firestore.FieldValue;

// The dashboard assistant: a member types on the Assistant page, the page queues an `assistant`
// task, and this answers into users/{uid}/chat. Every tool is bound to the uid of the member who
// asked: the model never supplies a uid and cannot reach another account, the code, or the Mac.
const SYSTEM = `You are the assistant built into Applyer, a private job-search dashboard with two members. You are talking to one member on the Assistant page.

What Applyer does: it searches job boards, scores each job against the member's profile (0-100; the Jobs page shows 70 and up), writes a tailored resume and cover letter for jobs scoring 80 and up, and tracks applications. The member applies on the employer's site by hand; Applyer never submits applications.

Use your tools to look things up and to make the changes the member asks for; do not guess at their data. A search takes about 25 minutes and a tailored resume plus cover letter about 2 minutes, so after starting a task say it is running and where the result will appear (Jobs page, the job's page, Resume page) instead of waiting for it.

Profile facts come from the member. Never invent employers, dates, degrees, numbers or skills; when something needed is missing, ask for it. Read a value back after you change it.

You cannot change how the dashboard itself works. When the member wants a new feature, a design change, or reports a bug you cannot fix with your tools, record it with log_request and tell them it has been passed to the developer.

Write short, plain answers. No markdown tables; simple lists are fine.`;

const PROFILE_ROOTS = ['personal', 'preferences', 'workAuthorization', 'availability', 'education', 'experience', 'projects', 'publications', 'awards', 'volunteer', 'skills', 'demographics'];
const JOB_STATUSES = ['new', 'saved', 'dismissed', 'applied', 'interview', 'offer', 'rejected'];
const TASK_TYPES = ['searchJobs', 'prepareBatch', 'prepareDocuments', 'optimizeResume'];
const DOC_TASKS = ['prepareBatch', 'prepareDocuments', 'optimizeResume', 'parseResume'];

// Firestore Timestamps -> ISO strings; file bytes never leave the worker.
const plain = (value) => JSON.stringify(value, (k, v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : /Bytes$/.test(k) ? undefined : v));

export function buildTools(db, uid) {
  const u = db.collection('users').doc(uid);
  const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const jobRow = (d) => { const j = d.data(); return { id: d.id, title: j.title, company: j.company, location: j.location, score: j.score, status: j.status, documentsReady: !!j.docs, appliedAt: j.appliedAt, notes: j.notes }; };

  return [
    betaTool({
      name: 'get_profile',
      description: "The member's whole profile: contact details, education, experience, skills, publications, job preferences (titles, locations), work authorization, availability.",
      inputSchema: obj({}),
      run: async () => plain((await u.collection('profile').doc('profile').get()).data() || {}),
    }),
    betaTool({
      name: 'update_profile',
      description: `Change profile fields. "changes" maps a dot path to its new value, e.g. {"personal.location": "Brampton, Ontario", "preferences.titles": ["Research Associate"]}. Arrays are replaced whole, so send the full new array. Top-level keys allowed: ${PROFILE_ROOTS.join(', ')}.`,
      inputSchema: obj({ changes: { type: 'object', description: 'dot path -> new value' } }, ['changes']),
      run: async ({ changes }) => {
        const bad = Object.keys(changes || {}).filter((p) => !PROFILE_ROOTS.includes(p.split('.')[0]));
        if (!changes || !Object.keys(changes).length) return 'Nothing to change.';
        if (bad.length) return `Not allowed: ${bad.join(', ')}. Allowed top-level keys: ${PROFILE_ROOTS.join(', ')}.`;
        await u.collection('profile').doc('profile').set({}, { merge: true });
        await u.collection('profile').doc('profile').update({ ...changes, updatedAt: FieldValue.serverTimestamp() });
        return `Saved: ${Object.keys(changes).join(', ')}. Documents made before this change are rebuilt the next time they are prepared.`;
      },
    }),
    betaTool({
      name: 'list_jobs',
      description: 'Jobs found for the member, best score first. Filter by minimum score, status, or text in the title/company. Returns at most 40 rows.',
      inputSchema: obj({ min_score: { type: 'number' }, status: { type: 'string', enum: JOB_STATUSES }, text: { type: 'string' }, limit: { type: 'number' } }),
      run: async ({ min_score = 0, status, text, limit = 25 }) => {
        const needle = (text || '').toLowerCase();
        const rows = (await u.collection('jobs').where('score', '>=', min_score).orderBy('score', 'desc').get()).docs.map(jobRow)
          .filter((j) => (!status || j.status === status) && (!needle || `${j.title} ${j.company}`.toLowerCase().includes(needle)));
        return plain({ total: rows.length, jobs: rows.slice(0, Math.min(limit, 40)) });
      },
    }),
    betaTool({
      name: 'get_job',
      description: 'One job in full: analysis (strong points, missing, concerns), links to the posting, the start of its description, and whether documents are ready.',
      inputSchema: obj({ job_id: { type: 'string' } }, ['job_id']),
      run: async ({ job_id }) => {
        const d = await u.collection('jobs').doc(String(job_id)).get();
        if (!d.exists) return 'No job with that id.';
        const j = d.data();
        return plain({ ...jobRow(d), analysis: j.analysis, posting: (j.sources || []).map((s) => s.applyUrl || s.url), salary: j.salary, workMode: j.workMode, posted: j.postedAt || j.postedText, description: String(j.description || '').slice(0, 2500) });
      },
    }),
    betaTool({
      name: 'set_job_status',
      description: 'Move a job: saved, dismissed, applied (the member has submitted it themselves), interview, offer, rejected, or back to new. Optional notes replace the job\'s notes.',
      inputSchema: obj({ job_id: { type: 'string' }, status: { type: 'string', enum: JOB_STATUSES }, notes: { type: 'string' } }, ['job_id', 'status']),
      run: async ({ job_id, status, notes }) => {
        const ref = u.collection('jobs').doc(String(job_id));
        if (!(await ref.get()).exists) return 'No job with that id.';
        await ref.update({ status, ...(status === 'applied' ? { appliedAt: FieldValue.serverTimestamp() } : {}), ...(notes == null ? {} : { notes }) });
        return `Job is now "${status}".`;
      },
    }),
    betaTool({
      name: 'start_task',
      description: 'Start background work: searchJobs (new job search, ~25 min), prepareBatch (resume + cover letter for every 80+ job without them), prepareDocuments (one job; needs job_id), optimizeResume (rebuild the general resume from the current profile).',
      inputSchema: obj({ type: { type: 'string', enum: TASK_TYPES }, job_id: { type: 'string' } }, ['type']),
      run: async ({ type, job_id }) => {
        const live = (await u.collection('tasks').where('status', 'in', ['queued', 'running']).get()).docs.map((d) => d.data().type);
        if (live.includes(type)) return `A ${type} task is already running.`;
        // LibreOffice renders one document at a time; two document tasks at once made one fail.
        if (DOC_TASKS.includes(type) && live.some((t) => DOC_TASKS.includes(t))) return `Another document task (${live.filter((t) => DOC_TASKS.includes(t)).join(', ')}) is running; start this one when it finishes.`;
        let payload = {};
        if (type === 'prepareDocuments') {
          if (!job_id || !(await u.collection('jobs').doc(String(job_id)).get()).exists) return 'prepareDocuments needs the id of an existing job.';
          payload = { jobId: String(job_id) };
        }
        if (type === 'optimizeResume') {
          const resume = (await u.collection('resumes').orderBy('uploadedAt', 'desc').limit(1).get()).docs[0];
          if (!resume) return 'No resume uploaded yet. The member uploads one on the Resume page first.';
          payload = { resumeId: resume.id };
        }
        const ref = await u.collection('tasks').add({ type, payload, status: 'queued', createdAt: FieldValue.serverTimestamp() });
        return `Started ${type} (task ${ref.id}).`;
      },
    }),
    betaTool({
      name: 'list_tasks',
      description: 'Recent background tasks with status, error text and the last log lines. Use it to say whether something finished or why it failed.',
      inputSchema: obj({ limit: { type: 'number' } }),
      run: async ({ limit = 8 }) => {
        const docs = (await u.collection('tasks').orderBy('createdAt', 'desc').limit(Math.min(limit, 20)).get()).docs;
        return plain(docs.map((d) => { const t = d.data(); return { id: d.id, type: t.type, status: t.status, createdAt: t.createdAt, error: t.error, result: t.type === 'assistant' ? undefined : t.result, lastLog: (t.log || []).slice(-3) }; }).filter((t) => t.type !== 'assistant'));
      },
    }),
    betaTool({
      name: 'list_resume_versions',
      description: 'Resume versions on file, newest first: label, pages, whether it fits the page limit, ATS score, and the job it was tailored for (if any).',
      inputSchema: obj({}),
      run: async () => plain((await u.collection('resumeVersions').orderBy('createdAt', 'desc').limit(15).select('label', 'pages', 'pageLimit', 'fits', 'ats.score', 'ats.problems', 'jobId', 'createdAt').get()).docs.map((d) => ({ id: d.id, ...d.data() }))),
    }),
    betaTool({
      name: 'log_request',
      description: 'Record a feature request, design change or bug report for the developer, in the member\'s own words plus any detail that helps.',
      inputSchema: obj({ text: { type: 'string' } }, ['text']),
      run: async ({ text }) => { await u.collection('requests').add({ text: String(text).slice(0, 4000), status: 'open', createdAt: FieldValue.serverTimestamp() }); return 'Recorded for the developer.'; },
    }),
  ];
}

// assistant({ db, uid, log }, { text }) -> { replyId }
export async function assistant({ db, uid, log }, { text }) {
  const chat = db.collection('users').doc(uid).collection('chat');
  const say = async (reply) => (await chat.add({ role: 'assistant', text: reply, createdAt: FieldValue.serverTimestamp() })).id;
  const key = apiKey();
  if (!key) return { replyId: await say('The assistant needs the Anthropic API key on the worker (~/.applyer/anthropic.key). Ask the owner to add it.') };

  // The page writes the member's message to chat before queuing this task.
  const history = (await chat.orderBy('createdAt', 'desc').limit(24).get()).docs.map((d) => d.data()).reverse()
    .filter((m) => m.text).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history.at(-1).role !== 'user') history.push({ role: 'user', content: String(text || '') });

  try {
    const client = new Anthropic({ apiKey: key });
    const final = await client.beta.messages.toolRunner({ model: MODEL, max_tokens: 8000, system: SYSTEM, tools: buildTools(db, uid), messages: history, max_iterations: 12 });
    const reply = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    await log(`assistant replied (${final.stop_reason})`);
    return { replyId: await say(reply || (final.stop_reason === 'refusal' ? 'I cannot help with that request.' : 'I ran out of steps before finishing. Tell me which part to continue with.')) };
  } catch (err) {
    const why = err instanceof Anthropic.AuthenticationError ? 'the API key was rejected' : err instanceof Anthropic.RateLimitError ? 'the AI service is rate limited, try again in a minute' : err instanceof Anthropic.APIError ? `AI service error ${err.status ?? ''}: ${err.message}` : err.message;
    await log(`assistant failed: ${why}`);
    return { replyId: await say(`Something went wrong on my side: ${why}.`) };
  }
}
