import { addDoc, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { useUser } from '../auth'
import { db } from '../firebase'
import { userCol } from '../lib/paths'
import type { Answer } from '../lib/types'

type AnswerRow = Answer & { id: string }

export default function Answers() {
  const { user } = useUser()
  const uid = user!.uid
  const [answers, setAnswers] = useState<AnswerRow[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [newQ, setNewQ] = useState('')
  const [newA, setNewA] = useState('')

  useEffect(() => {
    const q = query(userCol(uid, 'answers'), orderBy('question'))
    return onSnapshot(q, (snap) => setAnswers(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Answer) }))))
  }, [uid])

  async function saveAnswer(id: string) {
    await updateDoc(doc(db, 'users', uid, 'answers', id), { answer: draft, source: 'user' })
    setEditingId(null)
  }

  async function toggleApproved(row: AnswerRow) {
    await updateDoc(doc(db, 'users', uid, 'answers', row.id), { approved: !row.approved })
  }

  async function remove(id: string) {
    if (!confirm('Delete this answer?')) return
    await deleteDoc(doc(db, 'users', uid, 'answers', id))
  }

  async function add() {
    if (!newQ.trim() || !newA.trim()) return
    await addDoc(userCol(uid, 'answers'), {
      question: newQ.trim(),
      answer: newA.trim(),
      tags: [],
      source: 'user',
      approved: true,
    })
    setNewQ('')
    setNewA('')
  }

  const input = 'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm text-[var(--text)]'

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--text)]">Answers</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Reusable answers for application questions. Approved answers are used automatically when filling forms.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
        <h2 className="text-sm font-semibold text-[var(--text)]">Add an answer</h2>
        <input value={newQ} onChange={(e) => setNewQ(e.target.value)} placeholder="Question" className={input} />
        <textarea value={newA} onChange={(e) => setNewA(e.target.value)} placeholder="Answer" rows={2} className={input} />
        <button
          type="button"
          onClick={() => void add()}
          className="self-start rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
        >
          Add
        </button>
      </div>

      {answers == null ? (
        <p className="text-sm text-[var(--text-muted)]">Loading...</p>
      ) : answers.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No saved answers yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {answers.map((a) => (
            <div key={a.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-[var(--text)]">{a.question}</p>
                <span className="shrink-0 rounded-full bg-[var(--bg-sunken)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                  {a.source}
                </span>
              </div>
              {editingId === a.id ? (
                <textarea
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void saveAnswer(a.id)}
                  rows={2}
                  className={`${input} mt-2`}
                />
              ) : (
                <p
                  onClick={() => {
                    setEditingId(a.id)
                    setDraft(a.answer)
                  }}
                  className="mt-2 cursor-text whitespace-pre-wrap text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  {a.answer || 'Click to add an answer'}
                </p>
              )}
              <div className="mt-3 flex items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
                  <input type="checkbox" checked={a.approved} onChange={() => void toggleApproved(a)} /> Approved
                </label>
                <button type="button" onClick={() => void remove(a.id)} className="text-[var(--danger)] hover:underline">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
