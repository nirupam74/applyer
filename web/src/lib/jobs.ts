import { onSnapshot, orderBy, query, serverTimestamp, updateDoc, where } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { userCol, userDoc } from './paths'
import type { Job, SourceRun } from './types'

export type JobRow = Job & { id: string }

// Only jobs at or above the floor are read: every document read counts against the free daily quota,
// and an open list is re-read whenever a search rewrites its jobs.
export function useJobs(uid: string, minScore = 0) {
  const [jobs, setJobs] = useState<JobRow[] | null>(null)
  useEffect(
    () =>
      onSnapshot(query(userCol(uid, 'jobs'), where('score', '>=', minScore), orderBy('score', 'desc')), (snap) =>
        setJobs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Job) }))),
      ),
    [uid, minScore],
  )
  return jobs
}

// The Applications page: jobs the member acted on plus jobs with documents, not the whole list.
export function useTrackedJobs(uid: string) {
  const [parts, setParts] = useState<Record<string, JobRow[] | null>>({ tracked: null, ready: null })
  useEffect(() => {
    const rows = (key: string) => (snap: { docs: { id: string; data: () => unknown }[] }) =>
      setParts((p) => ({ ...p, [key]: snap.docs.map((d) => ({ id: d.id, ...(d.data() as Job) })) }))
    const a = onSnapshot(query(userCol(uid, 'jobs'), where('status', 'in', ['applied', 'interview', 'offer', 'rejected'])), rows('tracked'))
    const b = onSnapshot(query(userCol(uid, 'jobs'), where('docs.preparedAt', '>', new Date(0))), rows('ready'))
    return () => {
      a()
      b()
    }
  }, [uid])
  if (!parts.tracked || !parts.ready) return null
  return [...new Map([...parts.tracked, ...parts.ready].map((j) => [j.id, j])).values()]
}

export function useSourceRuns(uid: string) {
  const [runs, setRuns] = useState<Record<string, SourceRun>>({})
  useEffect(
    () =>
      onSnapshot(userCol(uid, 'sourceRuns'), (snap) =>
        setRuns(Object.fromEntries(snap.docs.map((d) => [d.id, d.data() as SourceRun]))),
      ),
    [uid],
  )
  return runs
}

export const TRACKED: Job['status'][] = ['applied', 'interview', 'offer', 'rejected']

export function setJobStatus(uid: string, id: string, status: Job['status']) {
  return updateDoc(userDoc(uid, 'jobs', id), { status, ...(status === 'applied' ? { appliedAt: serverTimestamp() } : {}) })
}

export const SOURCES = ['linkedin', 'indeed', 'ziprecruiter', 'glassdoor'] as const

export const SOURCE_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  ziprecruiter: 'ZipRecruiter',
  glassdoor: 'Glassdoor',
  hydroone: 'Hydro One careers',
}

export function daysAgo(ts: { toDate(): Date } | null | undefined): number | null {
  if (!ts) return null
  return Math.floor((Date.now() - ts.toDate().getTime()) / 86400e3)
}

export function postedLabel(job: Job): string {
  const d = daysAgo(job.postedAt)
  if (d == null) return job.postedText ?? 'unknown'
  if (d <= 0) return 'today'
  if (d === 1) return '1 day ago'
  return `${d} days ago`
}
