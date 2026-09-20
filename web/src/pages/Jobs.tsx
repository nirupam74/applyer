import { onSnapshot, setDoc } from 'firebase/firestore'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useUser } from '../auth'
import TaskStatus from '../components/TaskStatus'
import { SOURCES, SOURCE_LABEL, daysAgo, postedLabel, useJobs, useSourceRuns, type JobRow } from '../lib/jobs'
import { userDoc } from '../lib/paths'
import { enqueueTask, useActiveTask } from '../lib/tasks'

const MIN_SCORE = 70 // default floor of the list; each member's own choice is kept in settings/jobs.minScore

const WORK_MODES = ['remote', 'hybrid', 'onsite', 'unknown'] as const
const STATUSES = ['new', 'saved', 'dismissed', 'applied', 'interview', 'offer', 'rejected'] as const

const runStyle: Record<string, string> = {
  ok: 'text-[var(--success)]',
  blocked: 'text-[var(--warning)]',
  error: 'text-[var(--danger)]',
  running: 'text-[var(--accent)]',
}

export default function Jobs() {
  const { user } = useUser()
  const uid = user!.uid
  const jobs = useJobs(uid)
  const runs = useSourceRuns(uid)
  const [taskId, setTaskId] = useState<string | null>(null)
  const activeId = useActiveTask(uid, ['searchJobs', 'prepareBatch'])

  const [q, setQ] = useState('')
  const [minScore, setMinScoreState] = useState(MIN_SCORE)
  useEffect(() => onSnapshot(userDoc(uid, 'settings', 'jobs'), (snap) => setMinScoreState(snap.data()?.minScore ?? MIN_SCORE)), [uid])
  function setMinScore(value: number) {
    setMinScoreState(value)
    void setDoc(userDoc(uid, 'settings', 'jobs'), { minScore: value }, { merge: true })
  }
  const [workMode, setWorkMode] = useState('')
  const [source, setSource] = useState('')
  const [status, setStatus] = useState('')
  const [maxDays, setMaxDays] = useState(0)
  const [empType, setEmpType] = useState('')
  const [hasSalary, setHasSalary] = useState(false)
  const [rankedOnly, setRankedOnly] = useState(false)

  const empTypes = useMemo(() => [...new Set((jobs ?? []).map((j) => j.employmentType).filter(Boolean))].sort(), [jobs])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (jobs ?? []).filter((j) => {
      if (rankedOnly && j.rank == null && j.status !== 'saved') return false
      if (needle && !`${j.title} ${j.company} ${j.location}`.toLowerCase().includes(needle)) return false
      if (!((j.score ?? 0) >= minScore)) return false
      if (workMode && j.workMode !== workMode) return false
      if (source && !j.sources.some((s) => s.name === source)) return false
      if (status ? j.status !== status : j.status === 'dismissed') return false
      if (empType && j.employmentType !== empType) return false
      if (hasSalary && !j.salary) return false
      if (maxDays) {
        const d = daysAgo(j.postedAt)
        if (d == null || d > maxDays) return false
      }
      return true
    })
  }, [jobs, q, minScore, workMode, source, status, empType, hasSalary, maxDays, rankedOnly])

  async function searchNow() {
    setTaskId(await enqueueTask(uid, 'searchJobs', {}))
  }

  async function prepareAll() {
    setTaskId(await enqueueTask(uid, 'prepareBatch', {}))
  }

  const select = 'rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm text-[var(--text)]'

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text)]">Jobs</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {minScore > 0 ? `Jobs scoring ${minScore} or higher` : 'Every job found'}, ranked from your profile preferences and a resume-to-job analysis. Prepare documents writes a tailored resume and cover letter for every job scoring 80 or higher; you apply yourself from the job page.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={prepareAll}
            disabled={!!activeId}
            className="rounded-lg border border-[var(--border)] px-5 py-2.5 text-sm font-semibold text-[var(--text)] hover:bg-[var(--bg-sunken)] disabled:opacity-50"
          >
            Prepare documents
          </button>
          <button
            type="button"
            onClick={searchNow}
            disabled={!!activeId}
            className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {activeId ? 'Working...' : 'Search now'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--text-muted)]">
        {SOURCES.map((s) => {
          const r = runs[s]
          return (
            <span key={s}>
              {SOURCE_LABEL[s]}:{' '}
              <span className={r ? runStyle[r.status] : ''} title={r?.message}>
                {r ? `${r.status}${r.status === 'ok' || r.status === 'blocked' ? ` (${r.jobsFound})` : ''}` : 'never run'}
              </span>
              {r?.finishedAt && <span> {r.finishedAt.toDate().toLocaleString()}</span>}
            </span>
          )
        })}
      </div>

      {(activeId || taskId) && <TaskStatus uid={uid} taskId={(activeId || taskId)!} />}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title, company, location"
          className={`${select} w-64`}
        />
        <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
          Score ≥
          <input type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className={`${select} w-16`} />
        </label>
        <select value={workMode} onChange={(e) => setWorkMode(e.target.value)} className={select}>
          <option value="">Any work mode</option>
          {WORK_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={select}>
          <option value="">Any source</option>
          {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={select}>
          <option value="">Not dismissed</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={maxDays} onChange={(e) => setMaxDays(Number(e.target.value))} className={select}>
          <option value={0}>Any date</option>
          <option value={1}>Last 24 h</option>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
        <select value={empType} onChange={(e) => setEmpType(e.target.value)} className={select}>
          <option value="">Any type</option>
          {empTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
          <input type="checkbox" checked={hasSalary} onChange={(e) => setHasSalary(e.target.checked)} /> Salary listed
        </label>
        <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
          <input type="checkbox" checked={rankedOnly} onChange={(e) => setRankedOnly(e.target.checked)} /> Top 100 only
        </label>
        <span className="ml-auto text-xs text-[var(--text-muted)]">
          {jobs == null ? 'Loading' : `${rows.length} of ${jobs.length}`}
        </span>
      </div>

      {jobs != null && jobs.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No jobs yet. Press Search now to run discovery from your profile preferences.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border)]">
                <Th>#</Th><Th>Score</Th><Th>Title</Th><Th>Company</Th><Th>Location</Th><Th>Mode</Th><Th>Salary</Th><Th>Posted</Th><Th>Source</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => <Row key={j.id} job={j} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>
}

function Row({ job }: { job: JobRow }) {
  return (
    <tr className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-sunken)]">
      <td className="px-3 py-2 text-[var(--text-muted)]">{job.rank ?? ''}</td>
      <td className="px-3 py-2"><ScorePill score={job.score} matchPct={job.matchPct} /></td>
      <td className="px-3 py-2 font-medium text-[var(--text)]">
        <Link to={`/jobs/${job.id}`} className="hover:text-[var(--accent)]">{job.title}</Link>
      </td>
      <td className="px-3 py-2 text-[var(--text)]">{job.company}</td>
      <td className="px-3 py-2 text-[var(--text-muted)]">{job.location}</td>
      <td className="px-3 py-2 text-[var(--text-muted)]">{job.workMode === 'unknown' ? '' : job.workMode}</td>
      <td className="px-3 py-2 text-[var(--text-muted)]">{job.salary ?? ''}</td>
      <td className="px-3 py-2 text-[var(--text-muted)] whitespace-nowrap">{postedLabel(job)}</td>
      <td className="px-3 py-2 text-[var(--text-muted)]">{job.sources.map((s) => SOURCE_LABEL[s.name] ?? s.name).join(', ')}</td>
      <td className="px-3 py-2">
        <StatusPill status={job.status} />
        {job.docs && <span className="ml-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--accent)]" title="Tailored resume and cover letter are ready">docs</span>}
      </td>
    </tr>
  )
}

export function ScorePill({ score, matchPct }: { score: number; matchPct: number | null }) {
  const tone = score >= 80 ? 'bg-[var(--success-bg)] text-[var(--success)]' : score >= 60 ? 'bg-[var(--warning-bg)] text-[var(--warning)]' : 'bg-[var(--bg-sunken)] text-[var(--text-muted)]'
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`} title={matchPct == null ? 'heuristic only, not yet analyzed' : `LLM match ${matchPct}%`}>
      {score}{matchPct == null ? '*' : ''}
    </span>
  )
}

export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    new: 'bg-[var(--accent-soft)] text-[var(--accent)]',
    saved: 'bg-[var(--success-bg)] text-[var(--success)]',
    applied: 'bg-[var(--success-bg)] text-[var(--success)]',
    interview: 'bg-[var(--warning-bg)] text-[var(--warning)]',
    offer: 'bg-[var(--success-bg)] text-[var(--success)]',
    rejected: 'bg-[var(--danger-bg)] text-[var(--danger)]',
    dismissed: 'bg-[var(--bg-sunken)] text-[var(--text-muted)]',
  }
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${tone[status] ?? ''}`}>{status}</span>
}
