import { onSnapshot } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useUser } from '../auth'
import { profileDoc, userCol } from '../lib/paths'
import type { Profile } from '../lib/types'

function completeness(profile: Profile | null): number {
  if (!profile) return 0
  const checks: boolean[] = [
    !!profile.personal.name.trim(),
    !!profile.personal.email.trim(),
    !!profile.personal.phone.trim(),
    !!profile.personal.location.trim(),
    !!profile.personal.linkedin.trim(),
    !!profile.personal.portfolio.trim(),
    !!profile.personal.website.trim(),
    profile.personal.links.length > 0,
    profile.education.length > 0,
    profile.experience.length > 0,
    Object.values(profile.skills).some((list) => list.length > 0),
  ]
  const filled = checks.filter(Boolean).length
  return Math.round((filled / checks.length) * 100)
}

export default function Home() {
  const { user } = useUser()
  const uid = user!.uid

  const [resumeCount, setResumeCount] = useState<number | null>(null)
  const [versionCount, setVersionCount] = useState<number | null>(null)
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)

  useEffect(() => onSnapshot(userCol(uid, 'resumes'), (snap) => setResumeCount(snap.size)), [uid])
  useEffect(() => onSnapshot(userCol(uid, 'resumeVersions'), (snap) => setVersionCount(snap.size)), [uid])
  useEffect(
    () => onSnapshot(profileDoc(uid), (snap) => setProfile(snap.exists() ? (snap.data() as Profile) : null)),
    [uid],
  )

  const loading = resumeCount === null || versionCount === null || profile === undefined

  if (loading) {
    return <p className="text-sm text-[var(--text-muted)]">Loading...</p>
  }

  const pct = completeness(profile)

  if (resumeCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-[var(--border)] px-6 py-20 text-center">
        <h1 className="text-xl font-semibold text-[var(--text)]">Welcome to Applyer</h1>
        <p className="max-w-sm text-sm text-[var(--text-muted)]">
          Upload your first resume to extract a structured profile and start optimizing.
        </p>
        <Link
          to="/resume"
          className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
        >
          Upload a resume
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--text)]">Home</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">A quick look at where things stand.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Resumes uploaded" value={resumeCount} />
        <StatCard label="Optimized versions" value={versionCount} />
        <StatCard label="Profile completeness" value={`${pct}%`} />
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          to="/resume"
          className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          Go to Resume
        </Link>
        <Link
          to="/profile"
          className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          Go to Profile
        </Link>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
      <p className="text-sm text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-3xl font-semibold text-[var(--text)]">{value}</p>
    </div>
  )
}
