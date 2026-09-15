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

  function downloadBytes(bytes: Uint8Array, mime: string, extension: string) {
    const blob = new Blob([bytes], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${version!.fileName || `${profileName || 'Resume'} - Resume`}.${extension}`
    a.click()
    URL.revokeObjectURL(url)
  }

  function downloadDocx() {
    if (!version) return
    downloadBytes(
      version.docxBytes.toUint8Array(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx',
    )
  }

  function downloadPdf() {
    if (!version?.pdfBytes) return
    downloadBytes(version.pdfBytes.toUint8Array(), 'application/pdf', 'pdf')
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
        <div className="flex gap-2">
          <button
            type="button"
            onClick={downloadDocx}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
          >
            Download DOCX
          </button>
          {version.pdfBytes && (
            <button
              type="button"
              onClick={downloadPdf}
              className="rounded-lg border border-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            >
              Download PDF
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <AtsCard ats={version.ats} />
        {version.pages !== undefined && (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                version.fits === false
                  ? 'bg-[var(--warning-bg)] text-[var(--warning)]'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
              }`}
            >
              {version.fits === false
                ? `${version.pages} page${version.pages === 1 ? '' : 's'}, limit ${version.pageLimit}`
                : `${version.pages} page${version.pages === 1 ? '' : 's'}`}
            </span>
            {version.fits === false && (
              <p className="text-sm text-[var(--warning)]">
                This version runs to {version.pages} pages; the limit is {version.pageLimit}. Regenerate or shorten
                sections.
              </p>
            )}
          </div>
        )}
      </div>

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
