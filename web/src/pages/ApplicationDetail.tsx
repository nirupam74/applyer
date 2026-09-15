import { doc, onSnapshot } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useUser } from '../auth'
import TaskStatus from '../components/TaskStatus'
import { db } from '../firebase'
import { downloadBytes, safeUrl } from '../lib/download'
import { enqueueTask } from '../lib/tasks'
import type { Application, CoverLetter, Job, ResumeVersion } from '../lib/types'

const statusStyles: Record<string, string> = {
  preparing: 'bg-[var(--bg-sunken)] text-[var(--text-muted)]',
  filling: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  submitted: 'bg-[var(--success-bg)] text-[var(--success)]',
  blocked: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  failed: 'bg-[var(--danger-bg)] text-[var(--danger)]',
}

const confidenceStyles: Record<string, string> = {
  green: 'bg-[var(--success-bg)] text-[var(--success)]',
  yellow: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  red: 'bg-[var(--danger-bg)] text-[var(--danger)]',
}

export default function ApplicationDetail() {
  const { user } = useUser()
  const uid = user!.uid
  const { id } = useParams()
  const [app, setApp] = useState<Application | null | undefined>(undefined)
  const [job, setJob] = useState<Job | null>(null)
  const [resumeVersion, setResumeVersion] = useState<ResumeVersion | null>(null)
  const [coverLetter, setCoverLetter] = useState<CoverLetter | null>(null)
  const [retryTaskId, setRetryTaskId] = useState<string | null>(null)
  const [shotUrls, setShotUrls] = useState<string[]>([])

  useEffect(() => {
    if (!id) return
    return onSnapshot(doc(db, 'users', uid, 'applications', id), (snap) =>
      setApp(snap.exists() ? (snap.data() as Application) : null),
    )
  }, [uid, id])

  useEffect(() => {
    if (!app) return
    return onSnapshot(doc(db, 'users', uid, 'jobs', app.jobId), (snap) =>
      setJob(snap.exists() ? (snap.data() as Job) : null),
    )
  }, [uid, app])

  useEffect(() => {
    if (!app?.resumeVersionId) {
      setResumeVersion(null)
      return
    }
    return onSnapshot(doc(db, 'users', uid, 'resumeVersions', app.resumeVersionId), (snap) =>
      setResumeVersion(snap.exists() ? (snap.data() as ResumeVersion) : null),
    )
  }, [uid, app?.resumeVersionId])

  useEffect(() => {
    if (!app?.coverLetterId) {
      setCoverLetter(null)
      return
    }
    return onSnapshot(doc(db, 'users', uid, 'coverLetters', app.coverLetterId), (snap) =>
      setCoverLetter(snap.exists() ? (snap.data() as CoverLetter) : null),
    )
  }, [uid, app?.coverLetterId])

  useEffect(() => {
    if (!app?.screenshots?.length) {
      setShotUrls([])
      return
    }
    const urls = app.screenshots.map((b) => URL.createObjectURL(new Blob([b.toUint8Array()], { type: 'image/png' })))
    setShotUrls(urls)
    return () => urls.forEach((u) => URL.revokeObjectURL(u))
  }, [app?.screenshots])

  async function retry() {
    if (!app) return
    setRetryTaskId(await enqueueTask(uid, 'applyToJob', { jobId: app.jobId }))
  }

  if (app === undefined) return <p className="text-sm text-[var(--text-muted)]">Loading...</p>
  if (!app || !id) return <p className="text-sm text-[var(--danger)]">Application not found.</p>

  const btn = 'rounded-lg px-4 py-2 text-sm font-semibold'

  return (
    <div className="flex flex-col gap-6">
      <Link to="/applications" className="text-sm text-[var(--text-muted)] hover:text-[var(--accent)]">
        Back to applications
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${statusStyles[app.status]}`}>
            {app.status}
          </span>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--text)]">
            {job ? (
              <Link to={`/jobs/${app.jobId}`} className="hover:text-[var(--accent)]">
                {job.title}
              </Link>
            ) : (
              app.jobId
            )}
          </h1>
          {job && (
            <p className="text-sm text-[var(--text-muted)]">
              {job.company} · {job.location}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void retry()}
          className={`${btn} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-sunken)]`}
        >
          Retry
        </button>
      </div>

      {retryTaskId && <TaskStatus uid={uid} taskId={retryTaskId} />}

      {app.log.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
          <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">Log</h2>
          <div className="max-h-40 overflow-y-auto rounded-lg bg-[var(--bg-sunken)] p-2 font-mono text-xs text-[var(--text-muted)]">
            {app.log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}

      {app.status === 'failed' && app.error && <p className="text-sm text-[var(--danger)]">{app.error}</p>}

      {app.confirmation && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
          <h2 className="text-base font-semibold text-[var(--text)]">Confirmation</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--text)]">{app.confirmation}</p>
          {safeUrl(app.portalUrl) && (
            <a
              href={safeUrl(app.portalUrl)!}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-sm text-[var(--accent)] underline"
            >
              Open portal
            </a>
          )}
        </section>
      )}

      {(resumeVersion?.pdfBytes || coverLetter?.pdfBytes) && (
        <div className="flex flex-wrap gap-2">
          {resumeVersion?.pdfBytes && (
            <button
              type="button"
              onClick={() =>
                downloadBytes(
                  resumeVersion.pdfBytes!.toUint8Array(),
                  'application/pdf',
                  `${resumeVersion.fileName || 'Resume'}.pdf`,
                )
              }
              className="rounded-lg border border-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            >
              Download tailored resume
            </button>
          )}
          {coverLetter?.pdfBytes && (
            <button
              type="button"
              onClick={() =>
                downloadBytes(coverLetter.pdfBytes.toUint8Array(), 'application/pdf', `${coverLetter.fileName || 'Cover Letter'}.pdf`)
              }
              className="rounded-lg border border-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            >
              Download cover letter
            </button>
          )}
        </div>
      )}

      {app.review && app.review.fields.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
          <h2 className="text-base font-semibold text-[var(--text)]">Review</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <tr className="border-b border-[var(--border)]">
                  <Th>Field</Th>
                  <Th>Value</Th>
                  <Th>Confidence</Th>
                </tr>
              </thead>
              <tbody>
                {app.review.fields.map((f, i) => (
                  <tr key={i} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2 text-[var(--text)]">{f.name}</td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">{f.value}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${confidenceStyles[f.confidence]}`}
                      >
                        {f.confidence}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {shotUrls.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
          <h2 className="text-base font-semibold text-[var(--text)]">Screenshots</h2>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {shotUrls.map((u, i) => (
              <img key={i} src={u} alt={`Screenshot ${i + 1}`} className="rounded-lg border border-[var(--border)]" />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>
}
