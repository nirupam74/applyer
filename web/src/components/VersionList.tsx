import { deleteDoc, doc, onSnapshot, orderBy, query, setDoc, updateDoc } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { db } from '../firebase'
import { userCol, userDoc } from '../lib/paths'
import type { ResumeVersion } from '../lib/types'

interface VersionRow extends ResumeVersion {
  id: string
}

export default function VersionList({
  uid,
  selectedId,
  onSelect,
}: {
  uid: string
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const [versions, setVersions] = useState<VersionRow[] | null>(null)
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')

  useEffect(() => {
    const q = query(userCol(uid, 'resumeVersions'), orderBy('createdAt', 'desc'))
    return onSnapshot(q, (snap) => {
      setVersions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ResumeVersion) })))
    })
  }, [uid])

  useEffect(() => {
    return onSnapshot(userDoc(uid, 'settings', 'resume'), (snap) => {
      const data = snap.data() as { defaultVersionId?: string } | undefined
      setDefaultId(data?.defaultVersionId ?? null)
    })
  }, [uid])

  async function setDefault(id: string) {
    await setDoc(userDoc(uid, 'settings', 'resume'), { defaultVersionId: id }, { merge: true })
  }

  async function saveLabel(id: string) {
    await updateDoc(doc(db, 'users', uid, 'resumeVersions', id), { label: labelDraft })
    setEditingId(null)
  }

  async function remove(id: string) {
    if (!confirm('Delete this version? This cannot be undone.')) return
    await deleteDoc(doc(db, 'users', uid, 'resumeVersions', id))
    if (selectedId === id) onSelect('')
  }

  if (versions === null) {
    return <p className="text-sm text-[var(--text-muted)]">Loading versions...</p>
  }

  if (versions.length === 0) {
    return <p className="text-sm text-[var(--text-muted)]">No optimized versions yet.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {versions.map((v) => (
        <div
          key={v.id}
          onClick={() => onSelect(v.id)}
          className={`cursor-pointer rounded-lg border p-3 transition ${
            selectedId === v.id
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--accent)]/50'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            {editingId === v.id ? (
              <input
                autoFocus
                value={labelDraft}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={() => void saveLabel(v.id)}
                onKeyDown={(e) => e.key === 'Enter' && void saveLabel(v.id)}
                className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-sm text-[var(--text)] outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingId(v.id)
                  setLabelDraft(v.label)
                }}
                className="min-w-0 flex-1 truncate text-left text-sm font-medium text-[var(--text)] hover:underline"
              >
                {v.label || 'Untitled version'}
              </button>
            )}
            <span className="shrink-0 rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--success)]">
              {v.ats?.score ?? 0}
            </span>
            {v.pages !== undefined && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  v.fits === false
                    ? 'bg-[var(--warning-bg)] text-[var(--warning)]'
                    : 'bg-[var(--bg)] text-[var(--text-muted)]'
                }`}
              >
                {v.fits === false
                  ? `${v.pages} page${v.pages === 1 ? '' : 's'}, limit ${v.pageLimit}`
                  : `${v.pages} page${v.pages === 1 ? '' : 's'}`}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs text-[var(--text-muted)]">
            {defaultId === v.id ? (
              <span className="font-medium text-[var(--accent)]">Default</span>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void setDefault(v.id)
                }}
                className="hover:underline"
              >
                Set as default
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void remove(v.id)
              }}
              className="text-[var(--danger)] hover:underline"
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
