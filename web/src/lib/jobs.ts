import { onSnapshot, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { userCol, userDoc } from './paths'
import type { Job, SourceRun } from './types'

export type JobRow = Job & { id: string }

export function useJobs(uid: string) {
  const [jobs, setJobs] = useState<JobRow[] | null>(null)
  useEffect(
    () =>
      onSnapshot(query(userCol(uid, 'jobs'), orderBy('score', 'desc')), (snap) =>
        setJobs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Job) }))),
      ),
    [uid],
  )
  return jobs
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
