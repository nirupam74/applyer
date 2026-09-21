import { getDoc, onSnapshot } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useUser } from '../auth'
import TaskStatus from '../components/TaskStatus'
import { SOURCE_LABEL, TRACKED, postedLabel, setJobStatus } from '../lib/jobs'
import { downloadBytes, safeUrl } from '../lib/download'
import { userDoc } from '../lib/paths'
import { enqueueTask } from '../lib/tasks'
import type { CoverLetter, Job, ResumeVersion } from '../lib/types'
import { ScorePill, StatusPill } from './Jobs'

export default function JobDetail() {
  const { user } = useUser()
  const uid = user!.uid
  const { id } = useParams()
  const [job, setJob] = useState<Job | null | undefined>(undefined)
  const [prepTaskId, setPrepTaskId] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    return onSnapshot(userDoc(uid, 'jobs', id), (snap) => setJob(snap.exists() ? (snap.data() as Job) : null))
  }, [uid, id])

  async function prepare() {
    if (!id) return
    setPrepTaskId(await enqueueTask(uid, 'prepareDocuments', { jobId: id }))
  }

  // Fetched on click: each document carries up to ~1 MB of file bytes.
  async function download(kind: 'resume' | 'cover', ext: 'pdf' | 'docx', set: 'docs' | 'companyDocs' = 'docs') {
    const ids = job?.[set]
    if (!ids) return
    const snap = await getDoc(kind === 'resume' ? userDoc(uid, 'resumeVersions', ids.resumeVersionId) : userDoc(uid, 'coverLetters', ids.coverLetterId))
    const d = snap.data() as ResumeVersion | CoverLetter | undefined
    const bytes = ext === 'pdf' ? d?.pdfBytes : d?.docxBytes
    if (!d || !bytes) return
    const mime = ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    downloadBytes(bytes.toUint8Array(), mime, `${d.fileName || (kind === 'resume' ? 'Resume' : 'Cover Letter')}.${ext}`)
  }

  if (job === undefined) return <p className="text-sm text-[var(--text-muted)]">Loading...</p>
  if (!job || !id) return <p className="text-sm text-[var(--danger)]">Job not found.</p>

  const apply = safeUrl(job.sources[0]?.applyUrl ?? job.sources[0]?.url)
  const btn = 'rounded-lg px-4 py-2 text-sm font-semibold'
  const a = job.analysis

  return (
    <div className="flex flex-col gap-6">
      <Link to="/jobs" className="text-sm text-[var(--text-muted)] hover:text-[var(--accent)]">Back to jobs</Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {job.rank != null && <span className="text-sm text-[var(--text-muted)]">#{job.rank}</span>}
            <ScorePill score={job.score} matchPct={job.matchPct} />
            <StatusPill status={job.status} />
          </div>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--text)]">{job.title}</h1>
          <p className="text-sm text-[var(--text-muted)]">
            {job.company} · {job.location}
            {job.workMode !== 'unknown' && ` · ${job.workMode}`}
            {job.employmentType && ` · ${job.employmentType}`}
            {job.salary && ` · ${job.salary}`}
            {` · posted ${postedLabel(job)}`}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {job.sources.map((s) => (
              <a key={s.name} href={safeUrl(s.url) ?? undefined} target="_blank" rel="noreferrer" className="mr-3 underline hover:text-[var(--accent)]">
                {SOURCE_LABEL[s.name] ?? s.name}
              </a>
            ))}
          </p>
          {job.appliedAt && <p className="mt-1 text-xs text-[var(--text-muted)]">Applied {job.appliedAt.toDate().toLocaleDateString()}</p>}
        </div>
        <div className="flex gap-2">
          {apply && (
            <a href={apply} target="_blank" rel="noreferrer" className={`${btn} bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]`}>
              Open posting
            </a>
          )}
          {TRACKED.includes(job.status) ? (
            <select value={job.status} onChange={(e) => void setJobStatus(uid, id, e.target.value as Job['status'])} className={`${btn} border border-[var(--border)] bg-[var(--bg-elevated)] capitalize text-[var(--text)]`}>
              {TRACKED.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value="saved">not applied</option>
            </select>
          ) : (
            <button type="button" onClick={() => void setJobStatus(uid, id, 'applied')} className={`${btn} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-sunken)]`}>
              Mark applied
            </button>
          )}
          <button type="button" onClick={() => setJobStatus(uid, id, job.status === 'saved' ? 'new' : 'saved')} className={`${btn} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-sunken)]`}>
            {job.status === 'saved' ? 'Unsave' : 'Save'}
          </button>
          <button type="button" onClick={() => setJobStatus(uid, id, job.status === 'dismissed' ? 'new' : 'dismissed')} className={`${btn} border border-[var(--border)] text-[var(--danger)] hover:bg-[var(--danger-bg)]`}>
            {job.status === 'dismissed' ? 'Restore' : 'Dismiss'}
          </button>
        </div>
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">Your documents for this job</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {job.docs ? `Tailored resume and cover letter, made ${job.docs.preparedAt.toDate().toLocaleString()}.` : 'No tailored resume or cover letter yet. Making them takes about two minutes.'}
            </p>
          </div>
          <button type="button" onClick={() => void prepare()} className={`${btn} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-sunken)]`}>
            {job.docs ? 'Make again' : 'Make resume + cover letter'}
          </button>
        </div>
        {job.docs && (
          <div className="mt-3 flex flex-wrap gap-2">
            {([['resume', 'pdf', 'Resume PDF'], ['resume', 'docx', 'Resume DOCX'], ['cover', 'pdf', 'Cover letter PDF'], ['cover', 'docx', 'Cover letter DOCX']] as const).map(([kind, ext, label]) => (
              <button key={label} type="button" onClick={() => void download(kind, ext)} className={`${btn} bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--bg-sunken)]`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {job.companyDocs && (
          <div className="mt-4">
            <p className="text-sm text-[var(--text-muted)]">One master resume and cover letter for every {job.company} posting, for employers that take a single resume for all roles:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {([['resume', 'pdf', 'Master resume PDF'], ['resume', 'docx', 'Master resume DOCX'], ['cover', 'pdf', 'Master cover letter PDF'], ['cover', 'docx', 'Master cover letter DOCX']] as const).map(([kind, ext, label]) => (
                <button key={label} type="button" onClick={() => void download(kind, ext, 'companyDocs')} className={`${btn} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-sunken)]`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {prepTaskId && <div className="mt-3"><TaskStatus uid={uid} taskId={prepTaskId} /></div>}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
        <h2 className="text-base font-semibold text-[var(--text)]">Resume-to-job analysis</h2>
        {!a ? (
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            Not analyzed yet. Heuristic score {job.heuristic}. The next search analyzes the strongest candidates first.
          </p>
        ) : (
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2 flex items-center gap-3 text-sm">
              <span className="text-[var(--text)]">Match {a.matchPct ?? '?'}%</span>
              <span className="text-[var(--text-muted)]">Heuristic {job.heuristic}</span>
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-semibold capitalize text-[var(--accent)]">{a.recommendation}</span>
            </div>
            <List title="Strong" items={a.strong} tone="text-[var(--success)]" />
            <List title="Missing" items={a.missing} tone="text-[var(--danger)]" />
            <List title="Advantages" items={a.advantages} tone="text-[var(--accent)]" />
            <List title="Concerns" items={a.concerns} tone="text-[var(--warning)]" />
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
        <h2 className="text-base font-semibold text-[var(--text)]">Description</h2>
        {job.description ? (
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-[var(--text)]">{job.description}</pre>
        ) : (
          <p className="mt-2 text-sm text-[var(--text-muted)]">No description was captured for this listing. Open the source link to read it.</p>
        )}
      </section>
    </div>
  )
}

function List({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div>
      <h3 className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>{title}</h3>
      {items.length ? (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--text)]">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
      ) : (
        <p className="mt-1 text-sm text-[var(--text-muted)]">None listed.</p>
      )}
    </div>
  )
}
