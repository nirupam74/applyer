import { updateDoc } from 'firebase/firestore'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useUser } from '../auth'
import { TRACKED, setJobStatus, useJobs, type JobRow } from '../lib/jobs'
import { safeUrl } from '../lib/download'
import { userDoc } from '../lib/paths'
import type { Job } from '../lib/types'
import { ScorePill } from './Jobs'

// The user applies by hand; this page is the record of it. A job lands here when it is marked
// applied on its page, and its status is moved along from here.
export default function Applications() {
  const { user } = useUser()
  const uid = user!.uid
  const jobs = useJobs(uid)

  const { tracked, ready } = useMemo(() => {
    const all = jobs ?? []
    const byDate = (a: JobRow, b: JobRow) => (b.appliedAt?.toMillis() ?? 0) - (a.appliedAt?.toMillis() ?? 0)
    return {
      tracked: all.filter((j) => TRACKED.includes(j.status)).sort(byDate),
      ready: all.filter((j) => j.docs && ['new', 'saved'].includes(j.status)).sort((a, b) => b.score - a.score),
    }
  }, [jobs])

  if (jobs === null) return <p className="text-sm text-[var(--text-muted)]">Loading...</p>

  const counts = TRACKED.map((s) => `${tracked.filter((j) => j.status === s).length} ${s}`).join(' · ')
  const select = 'rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm capitalize text-[var(--text)]'

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--text)]">Applications</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Jobs you have applied to, and where each one stands. {counts}</p>
      </div>

      <Section title="Ready to apply" empty="No jobs with documents waiting. Use Prepare documents on the Jobs page.">
        {ready.map((j) => (
          <Row key={j.id} job={j}>
            <button type="button" onClick={() => void setJobStatus(uid, j.id, 'applied')} className="rounded-lg border border-[var(--border)] px-3 py-1 text-sm font-semibold text-[var(--text)] hover:bg-[var(--bg-sunken)]">
              Mark applied
            </button>
          </Row>
        ))}
      </Section>

      <Section title="Applied" empty="Nothing yet. Open a job, apply on the employer's site, then press Mark applied.">
        {tracked.map((j) => (
          <Row key={j.id} job={j} note={(notes) => void updateDoc(userDoc(uid, 'jobs', j.id), { notes })}>
            <span className="text-xs text-[var(--text-muted)]">{j.appliedAt ? j.appliedAt.toDate().toLocaleDateString() : ''}</span>
            <select value={j.status} onChange={(e) => void setJobStatus(uid, j.id, e.target.value as Job['status'])} className={select}>
              {TRACKED.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value="saved">not applied</option>
            </select>
          </Row>
        ))}
      </Section>
    </div>
  )
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
      <h2 className="text-base font-semibold text-[var(--text)]">{title} ({children.length})</h2>
      {children.length ? <div className="mt-3 flex flex-col divide-y divide-[var(--border)]">{children}</div> : <p className="mt-2 text-sm text-[var(--text-muted)]">{empty}</p>}
    </section>
  )
}

function Row({ job, note, children }: { job: JobRow; note?: (text: string) => void; children: React.ReactNode }) {
  const posting = safeUrl(job.sources[0]?.applyUrl ?? job.sources[0]?.url)
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <ScorePill score={job.score} matchPct={job.matchPct} />
      <div className="min-w-0 flex-1">
        <Link to={`/jobs/${job.id}`} className="text-sm font-semibold text-[var(--text)] hover:text-[var(--accent)]">{job.title}</Link>
        <p className="text-xs text-[var(--text-muted)]">{job.company} · {job.location}</p>
        {note && (
          <input
            defaultValue={job.notes ?? ''}
            onBlur={(e) => e.target.value !== (job.notes ?? '') && note(e.target.value)}
            placeholder="Notes (contact, interview date, follow-up)"
            className="mt-1 w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-[var(--text)] hover:border-[var(--border)] focus:border-[var(--border)] focus:outline-none"
          />
        )}
      </div>
      {posting && <a href={posting} target="_blank" rel="noreferrer" className="text-sm text-[var(--accent)] hover:underline">Open posting</a>}
      {children}
    </div>
  )
}
