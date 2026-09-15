import { signInWithEmailAndPassword } from 'firebase/auth'
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useUser } from '../auth'
import { auth } from '../firebase'

function errorMessage(code: string): string {
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address does not look right.'
    case 'auth/user-not-found':
    case 'auth/invalid-credential':
      return 'We do not recognize that email and password combination.'
    case 'auth/wrong-password':
      return 'That password is incorrect.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.'
    default:
      return 'Something went wrong signing in. Please try again.'
  }
}

export default function Login() {
  const { user, loading } = useUser()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!loading && user) {
    const from = (location.state as { from?: Location })?.from
    return <Navigate to={from?.pathname ?? '/home'} replace />
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      setError(errorMessage(code))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent)] text-lg font-bold text-[var(--accent-fg)]">
            A
          </div>
          <h1 className="text-xl font-semibold text-[var(--text)]">Sign in to Applyer</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Your personal application dashboard</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-sm"
        >
          {error && (
            <div className="mb-4 rounded-lg border border-[var(--danger)]/20 bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger)]">
              {error}
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

          <label className="mb-1 block text-sm font-medium text-[var(--text)]" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            placeholder="********"
          />

          <div className="mb-5 text-right">
            <Link to="/forgot-password" className="text-sm text-[var(--accent)] hover:underline">
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent-fg)] transition hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
