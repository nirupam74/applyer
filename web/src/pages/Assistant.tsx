import { addDoc, limitToLast, onSnapshot, orderBy, query, serverTimestamp, type Timestamp } from 'firebase/firestore'
import { useEffect, useRef, useState } from 'react'
import { useUser } from '../auth'
import { userCol } from '../lib/paths'
import { enqueueTask } from '../lib/tasks'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: Timestamp | null
}

const STARTERS = [
  'What should I apply to first?',
  'Find new jobs for me',
  'Make documents for my best matches',
  'Did anything fail today?',
]

// Talk to the assistant that runs in the worker. It can read and change this member's own
// profile, jobs and tasks; each message is answered by an `assistant` task.
export default function Assistant() {
  const { user } = useUser()
  const uid = user!.uid
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      onSnapshot(query(userCol(uid, 'chat'), orderBy('createdAt', 'asc'), limitToLast(100)), (snap) =>
        setMessages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ChatMessage, 'id'>) }))),
      ),
    [uid],
  )

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages])

  const waiting = !!messages?.length && messages[messages.length - 1].role === 'user'

  async function send(text: string) {
    const clean = text.trim()
    if (!clean || sending || waiting) return
    setSending(true)
    setDraft('')
    try {
      await addDoc(userCol(uid, 'chat'), { role: 'user', text: clean, createdAt: serverTimestamp() })
      await enqueueTask(uid, 'assistant', { text: clean })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-10rem)] flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--text)]">Assistant</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Ask about your jobs and applications, or tell it what to do: update your profile, start a search, make a resume and cover letter, mark a job applied. Anything it cannot do itself is passed to the developer.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
        {messages === null ? (
          <p className="text-sm text-[var(--text-muted)]">Loading...</p>
        ) : messages.length === 0 ? (
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} className="rounded-full border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--bg-sunken)]">
                {s}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <div key={m.id} className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-4 py-2 text-sm leading-relaxed ${m.role === 'user' ? 'self-end bg-[var(--accent)] text-[var(--accent-fg)]' : 'self-start bg-[var(--bg-sunken)] text-[var(--text)]'}`}>
                {m.text}
              </div>
            ))}
            {waiting && <div className="self-start rounded-xl bg-[var(--bg-sunken)] px-4 py-2 text-sm text-[var(--text-muted)]">Working on it... (needs the worker Mac to be on)</div>}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send(draft)
        }}
        className="flex gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={waiting ? 'Waiting for the reply...' : 'Message the assistant'}
          disabled={waiting}
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2.5 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
        />
        <button type="submit" disabled={!draft.trim() || sending || waiting} className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  )
}
