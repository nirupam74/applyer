import { addDoc, doc, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { db } from '../firebase'
import { userCol } from './paths'
import type { Task } from './types'

export async function enqueueTask(
  uid: string,
  type: Task['type'],
  payload: Record<string, unknown>,
): Promise<string> {
  const ref = await addDoc(userCol(uid, 'tasks'), {
    type,
    payload,
    status: 'queued',
    log: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export function useTask(uid: string | undefined, taskId: string | undefined) {
  const [task, setTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!uid || !taskId) {
      setTask(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const ref = doc(db, 'users', uid, 'tasks', taskId)
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setTask(snap.exists() ? (snap.data() as Task) : null)
        setLoading(false)
      },
      () => setLoading(false),
    )
    return unsub
  }, [uid, taskId])

  return { task, loading }
}
