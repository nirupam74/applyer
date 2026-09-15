import { limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { userCol } from './paths'
import type { Application } from './types'

export type ApplicationRow = Application & { id: string }

export function useApplications(uid: string) {
  const [apps, setApps] = useState<ApplicationRow[] | null>(null)
  useEffect(
    () =>
      onSnapshot(query(userCol(uid, 'applications'), orderBy('createdAt', 'desc')), (snap) =>
        setApps(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Application) }))),
      ),
    [uid],
  )
  return apps
}

export function useApplicationForJob(uid: string, jobId: string) {
  const [app, setApp] = useState<ApplicationRow | null | undefined>(undefined)
  useEffect(() => {
    const q = query(userCol(uid, 'applications'), where('jobId', '==', jobId), limit(1))
    return onSnapshot(q, (snap) =>
      setApp(snap.empty ? null : { id: snap.docs[0].id, ...(snap.docs[0].data() as Application) }),
    )
  }, [uid, jobId])
  return app
}
