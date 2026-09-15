import { onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { useUser } from '../auth'
import ProfileEditor from '../components/ProfileEditor'
import { profileDoc } from '../lib/paths'
import { emptyProfile, type Profile } from '../lib/types'

export default function ProfilePage() {
  const { user } = useUser()
  const uid = user!.uid

  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

  useEffect(() => {
    return onSnapshot(
      profileDoc(uid),
      (snap) => {
        setProfile(snap.exists() ? (snap.data() as Profile) : emptyProfile())
      },
      () => setError(true),
    )
  }, [uid])

  async function save(next: Profile) {
    setProfile(next)
    setSaveState('saving')
    try {
      await setDoc(profileDoc(uid), { ...next, updatedAt: serverTimestamp() }, { merge: true })
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1500)
    } catch {
      setSaveState('idle')
    }
  }

  if (error) {
    return <p className="text-sm text-[var(--danger)]">Could not load your profile. Try refreshing.</p>
  }

  if (!profile) {
    return <p className="text-sm text-[var(--text-muted)]">Loading profile...</p>
  }

  return (
    <div className="flex flex-col gap-6 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text)]">Profile</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            This information powers extraction, optimization, and matching.
          </p>
        </div>
        <span className="text-xs text-[var(--text-muted)]">
          {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : ''}
        </span>
      </div>

      <ProfileEditor value={profile} onChange={(v) => void save(v)} />
    </div>
  )
}
