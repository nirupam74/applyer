import { addDoc, Bytes, serverTimestamp } from 'firebase/firestore'
import { useRef, useState } from 'react'
import { enqueueTask } from '../lib/tasks'
import { userCol } from '../lib/paths'

const MAX_BYTES = 900 * 1024
const ACCEPTED = '.pdf,.docx,.txt'

export default function ResumeUpload({
  uid,
  onUploaded,
}: {
  uid: string
  onUploaded: (resumeId: string, taskId: string) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setError(null)

    if (file.size > MAX_BYTES) {
      setError(`"${file.name}" is ${(file.size / 1024).toFixed(0)} KB, over the 900 KB limit. Choose a smaller file.`)
      return
    }

    setUploading(true)
    try {
      const buffer = await file.arrayBuffer()
      const bytes = Bytes.fromUint8Array(new Uint8Array(buffer))
      const resumeRef = await addDoc(userCol(uid, 'resumes'), {
        name: file.name,
        mime: file.type || 'application/octet-stream',
        bytes,
        uploadedAt: serverTimestamp(),
      })
      const taskId = await enqueueTask(uid, 'parseResume', { resumeId: resumeRef.id })
      onUploaded(resumeRef.id, taskId)
    } catch {
      setError('Upload failed. Please try again.')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-elevated)] p-6 text-center">
      <p className="mb-1 text-sm font-medium text-[var(--text)]">Upload a resume</p>
      <p className="mb-4 text-sm text-[var(--text-muted)]">PDF, DOCX or TXT, up to 900 KB</p>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="hidden"
        id="resume-file"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFile(file)
        }}
      />
      <label
        htmlFor="resume-file"
        className="inline-block cursor-pointer rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] transition hover:bg-[var(--accent-hover)]"
      >
        {uploading ? 'Uploading...' : 'Choose file'}
      </label>
      {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
    </div>
  )
}
