import { sendPasswordResetEmail } from 'firebase/auth'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { auth } from '../firebase'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setStatus('sending')
    try {
      await sendPasswordResetEmail(auth, email.trim())
      setStatus('sent')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-[var(--text)]">Reset your password</h1>
        <p className="mb-6 text-sm text-[var(--text-muted)]">
          Enter your email and we will send a reset link.
        </p>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-sm"
        >
          {status === 'sent' && (
            <div className="mb-4 rounded-lg border border-[var(--success)]/20 bg-[var(--success-bg)] px-3 py-2 text-sm text-[var(--success)]">
              If that email has an account, a reset link is on its way.
            </div>
          )}
          {status === 'error' && (
            <div className="mb-4 rounded-lg border border-[var(--danger)]/20 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger)]">
              Could not send the reset email. Check the address and try again.
            </div>
          )}

          <label className="mb-1 block text-sm font-medium text-[var(--text)]" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            placeholder="you@example.com"
          />

          <button
            type="submit"
            disabled={status === 'sending'}
            className="mb-4 w-full rounded-lg bg-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent-fg)] transition hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            {status === 'sending' ? 'Sending...' : 'Send reset link'}
          </button>

          <Link to="/login" className="block text-center text-sm text-[var(--accent)] hover:underline">
            Back to sign in
          </Link>
        </form>
      </div>
    </div>
  )
}
