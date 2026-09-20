import { addDoc, doc, onSnapshot, query, serverTimestamp, where } from 'firebase/firestore'
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

// Id of this member's oldest queued or running task of the given types, or null. Survives leaving
// the page, so a search started earlier still shows and its button stays off.
export function useActiveTask(uid: string, types: Task['type'][]) {
  const [id, setId] = useState<string | null>(null)
  const key = types.join()
  useEffect(
    () =>
      onSnapshot(query(userCol(uid, 'tasks'), where('status', 'in', ['queued', 'running'])), (snap) => {
        const mine = snap.docs.filter((d) => key.split(',').includes(d.data().type))
        mine.sort((a, b) => (a.data().createdAt?.toMillis() ?? Infinity) - (b.data().createdAt?.toMillis() ?? Infinity))
        setId(mine[0]?.id ?? null)
      }),
    [uid, key],
  )
  return id
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
