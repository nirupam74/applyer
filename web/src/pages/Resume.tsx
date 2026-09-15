import { doc, onSnapshot, setDoc } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { useUser } from '../auth'
import CompareView from '../components/CompareView'
import ResumeUpload from '../components/ResumeUpload'
import TaskStatus from '../components/TaskStatus'
import VersionList from '../components/VersionList'
import { db } from '../firebase'
import { userDoc } from '../lib/paths'
import { enqueueTask } from '../lib/tasks'
import type { Profile } from '../lib/types'

export default function Resume() {
  const { user } = useUser()
  const uid = user!.uid

  const [uploadState, setUploadState] = useState<{ resumeId: string; taskId: string } | null>(null)
  const [optimizeTaskId, setOptimizeTaskId] = useState<string | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [maxPages, setMaxPages] = useState(1)

  useEffect(() => {
    return onSnapshot(doc(db, 'users', uid, 'profile', 'profile'), (snap) => {
      setProfile(snap.exists() ? (snap.data() as Profile) : null)
    })
  }, [uid])

  useEffect(() => {
    return onSnapshot(userDoc(uid, 'settings', 'resume'), (snap) => {
      const data = snap.data() as { maxPages?: number } | undefined
      setMaxPages(data?.maxPages ?? 1)
    })
  }, [uid])

  async function updateMaxPages(value: number) {
    setMaxPages(value)
    await setDoc(userDoc(uid, 'settings', 'resume'), { maxPages: value }, { merge: true })
  }

  async function handleOptimize() {
    if (!uploadState) return
    const taskId = await enqueueTask(uid, 'optimizeResume', { resumeId: uploadState.resumeId })
    setOptimizeTaskId(taskId)
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text)]">Resume</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Upload a resume, extract your profile, then optimize and compare versions.
          </p>
        </div>
        <div className="text-right">
          <label className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
            Page limit
            <select
              value={maxPages}
              onChange={(e) => void updateMaxPages(Number(e.target.value))}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm text-[var(--text)]"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          <p className="mt-1 max-w-[220px] text-xs text-[var(--text-muted)]">
            Every optimized version is rendered and checked against this limit.
          </p>
        </div>
      </div>

      <ResumeUpload
        uid={uid}
        onUploaded={(resumeId, taskId) => {
          setUploadState({ resumeId, taskId })
          setOptimizeTaskId(null)
        }}
      />

      {uploadState && (
        <div className="flex flex-col gap-3">
          <TaskStatus uid={uid} taskId={uploadState.taskId} />
          <TaskStatusGate uid={uid} taskId={uploadState.taskId} onDone={handleOptimize} optimizing={!!optimizeTaskId} />
          {optimizeTaskId && <TaskStatus uid={uid} taskId={optimizeTaskId} />}
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[280px_1fr]">
        <div>
          <h2 className="mb-3 text-sm font-semibold text-[var(--text)]">Versions</h2>
          <VersionList uid={uid} selectedId={selectedVersionId} onSelect={setSelectedVersionId} />
        </div>

        <div>
          {selectedVersionId ? (
            <CompareView uid={uid} versionId={selectedVersionId} profileName={profile?.personal.name ?? ''} />
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">
              Select a version to compare it against the original.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TaskStatusGate({
  uid,
  taskId,
  onDone,
  optimizing,
}: {
  uid: string
  taskId: string
  onDone: () => void
  optimizing: boolean
}) {
  const [done, setDone] = useState(false)

  useEffect(() => {
    return onSnapshot(doc(db, 'users', uid, 'tasks', taskId), (snap) => {
      const status = (snap.data() as { status?: string } | undefined)?.status
      setDone(status === 'done')
    })
  }, [uid, taskId])

  if (!done) return null

  return (
    <button
      type="button"
      onClick={onDone}
      disabled={optimizing}
      className="self-start rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] disabled:opacity-60"
    >
      Optimize
    </button>
  )
}
