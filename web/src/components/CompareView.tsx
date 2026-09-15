import { doc, onSnapshot, updateDoc } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { db } from '../firebase'
import { enqueueTask } from '../lib/tasks'
import type { Resume, ResumeVersion, StructuredResume } from '../lib/types'
import AtsCard from './AtsCard'
import ProfileEditor from './ProfileEditor'
import TaskStatus from './TaskStatus'

const SECTIONS: { key: keyof StructuredResume; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'education', label: 'Education' },
  { key: 'experience', label: 'Experience' },
  { key: 'projects', label: 'Projects' },
  { key: 'skills', label: 'Skills' },
]

export default function CompareView({
  uid,
  versionId,
  profileName,
}: {
  uid: string
  versionId: string
  profileName: string
}) {
  const [resume, setResume] = useState<Resume | null | undefined>(undefined)
  const [version, setVersion] = useState<ResumeVersion | null | undefined>(undefined)
  const [regenTask, setRegenTask] = useState<{ section: string; taskId: string } | null>(null)

  useEffect(() => {
    return onSnapshot(doc(db, 'users', uid, 'resumeVersions', versionId), (snap) => {
      setVersion(snap.exists() ? (snap.data() as ResumeVersion) : null)
    })
  }, [uid, versionId])

  useEffect(() => {
    if (!version) return
    return onSnapshot(doc(db, 'users', uid, 'resumes', version.resumeId), (snap) => {
      setResume(snap.exists() ? (snap.data() as Resume) : null)
    })
  }, [uid, version])

  async function regenerate(section: keyof StructuredResume) {
    if (!version) return
    const taskId = await enqueueTask(uid, 'optimizeResume', { resumeId: version.resumeId, versionId, section })
    setRegenTask({ section, taskId })
  }

  async function saveStructured(structured: StructuredResume) {
    await updateDoc(doc(db, 'users', uid, 'resumeVersions', versionId), { structured })
  }

  function download() {
    if (!version) return
    const blob = new Blob([version.docxBytes.toUint8Array()], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${profileName || 'Resume'} - Resume.docx`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (resume === undefined || version === undefined) {
    return <p className="text-sm text-[var(--text-muted)]">Loading comparison...</p>
  }

  if (resume === null || version === null) {
    return <p className="text-sm text-[var(--danger)]">Could not load this resume or version.</p>
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-[var(--text)]">{version.label || 'Optimized version'}</h3>
        <button
          type="button"
          onClick={download}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
        >
          Download DOCX
        </button>
      </div>

      <AtsCard ats={version.ats} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-semibold text-[var(--text)]">Original text</h4>
          <div className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 text-sm text-[var(--text-muted)]">
            {resume.text || 'No extracted text yet.'}
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-[var(--text)]">Optimized (editable)</h4>
            <div className="flex flex-wrap gap-1.5">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => void regenerate(s.key)}
                  className="rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  Regenerate {s.label}
                </button>
              ))}
            </div>
          </div>
          {regenTask && (
            <div className="mb-3">
              <TaskStatus uid={uid} taskId={regenTask.taskId} />
            </div>
          )}
          <div className="max-h-[32rem] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
            <ProfileEditor value={version.structured} onChange={(v) => void saveStructured(v)} />
          </div>
        </div>
      </div>
    </div>
  )
}
