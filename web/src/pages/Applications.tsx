import { onSnapshot, setDoc } from 'firebase/firestore'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useUser } from '../auth'
import TaskStatus from '../components/TaskStatus'
import { useApplications, type ApplicationRow } from '../lib/applications'
import { useJobs, type JobRow } from '../lib/jobs'
import { userDoc } from '../lib/paths'
import { enqueueTask } from '../lib/tasks'
import type { ApplicationSettings } from '../lib/types'

const statusStyles: Record<string, string> = {
  preparing: 'bg-[var(--bg-sunken)] text-[var(--text-muted)]',
  filling: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  submitted: 'bg-[var(--success-bg)] text-[var(--success)]',
  blocked: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  needs_human: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  failed: 'bg-[var(--danger-bg)] text-[var(--danger)]',
}

export default function Applications() {
  const { user } = useUser()
  const uid = user!.uid
  const apps = useApplications(uid)
  const jobs = useJobs(uid)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [settings, setSettings] = useState<ApplicationSettings>({ email: '', autoSubmit: false })

  useEffect(
    () =>
      onSnapshot(userDoc(uid, 'settings', 'applications'), (snap) => {
        const data = snap.data() as Partial<ApplicationSettings> | undefined
        setSettings({ email: data?.email ?? '', autoSubmit: data?.autoSubmit ?? false })
      }),
    [uid],
  )

  const jobsById = useMemo(() => new Map((jobs ?? []).map((j) => [j.id, j])), [jobs])

  async function applyToSaved() {
    setTaskId(await enqueueTask(uid, 'applyBatch', {}))
  }

  async function toggleAutoSubmit() {
    const autoSubmit = !settings.autoSubmit
    setSettings((s) => ({ ...s, autoSubmit }))
    await setDoc(userDoc(uid, 'settings', 'applications'), { autoSubmit }, { merge: true })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text)]">Applications</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Track application status, review filled fields, and manage submissions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void applyToSaved()}
          className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
        >
          Apply to saved jobs
        </button>
      </div>

      {taskId && <TaskStatus uid={uid} taskId={taskId} />}

      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-sm">
        <span className="text-[var(--text-muted)]">
          Application email: <span className="text-[var(--text)]">{settings.email || 'not set'}</span>
        </span>
        <label className="ml-auto flex items-center gap-2 text-[var(--text-muted)]">
          Auto-submit
          <input type="checkbox" checked={settings.autoSubmit} onChange={() => void toggleAutoSubmit()} />
        </label>
      </div>

      {apps != null && apps.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No applications yet. Apply from a job's page, or press Apply to saved jobs.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border)]">
                <Th>Title</Th>
                <Th>Company</Th>
                <Th>Status</Th>
                <Th>Submitted</Th>
                <Th>Confirmation</Th>
                <Th>Review</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {(apps ?? []).map((a) => (
                <Row key={a.id} app={a} job={jobsById.get(a.jobId)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>
}

function Row({ app, job }: { app: ApplicationRow; job: JobRow | undefined }) {
  const counts = { green: 0, yellow: 0, red: 0 }
  for (const f of app.review?.fields ?? []) counts[f.confidence]++

  return (
    <tr className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-sunken)]">
      <td className="px-3 py-2 font-medium text-[var(--text)]">
        <Link to={`/applications/${app.id}`} className="hover:text-[var(--accent)]">
          {job?.title ?? app.jobId}
        </Link>
      </td>
      <td className="px-3 py-2 text-[var(--text-muted)]">{job?.company ?? ''}</td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${statusStyles[app.status]}`}>
          {app.status.replace("_", " ")}
        </span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-[var(--text-muted)]">
        {app.submittedAt ? app.submittedAt.toDate().toLocaleDateString() : ''}
      </td>
      <td className="max-w-[240px] truncate px-3 py-2 text-[var(--text-muted)]">{app.confirmation ?? ''}</td>
      <td className="px-3 py-2 text-xs">
        {app.review && (
          <span className="flex gap-2">
            <span className="text-[var(--success)]">{counts.green}</span>
            <span className="text-[var(--warning)]">{counts.yellow}</span>
            <span className="text-[var(--danger)]">{counts.red}</span>
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <Link to={`/applications/${app.id}`} className="text-[var(--accent)] hover:underline">
          View
        </Link>
      </td>
    </tr>
  )
}
