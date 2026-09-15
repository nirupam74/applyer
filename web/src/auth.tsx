import { onAuthStateChanged, signOut as firebaseSignOut, type User } from 'firebase/auth'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { auth } from './firebase'

interface AuthState {
  user: User | null
  loading: boolean
}

const AuthContext = createContext<AuthState>({ user: null, loading: true })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u)
      setLoading(false)
    })
  }, [])

  return <AuthContext.Provider value={{ user, loading }}>{children}</AuthContext.Provider>
}

export function useUser(): AuthState {
  return useContext(AuthContext)
}

export function signOut(): Promise<void> {
  return firebaseSignOut(auth)
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useUser()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)] text-[var(--text-muted)]">
        Loading...
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}
