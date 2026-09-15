import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { signOut, useUser } from '../auth'

type Theme = 'light' | 'dark'

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('applyer-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const navItems = [
  { to: '/home', label: 'Home' },
  { to: '/resume', label: 'Resume' },
  { to: '/profile', label: 'Profile' },
]

export default function Shell() {
  const { user } = useUser()
  const navigate = useNavigate()
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [menuOpen, setMenuOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('applyer-theme', theme)
  }, [theme])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
      isActive
        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
        : 'text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]'
    }`

  return (
    <div className="flex min-h-screen bg-[var(--bg)] md:flex-row flex-col">
      {/* Sidebar (desktop) */}
      <aside className="hidden w-60 shrink-0 border-r border-[var(--border)] bg-[var(--bg-elevated)] md:flex md:flex-col">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-[var(--accent-fg)]">
            A
          </div>
          <span className="text-base font-semibold text-[var(--text)]">Applyer</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[var(--border)] p-3">
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </aside>

      {/* Top bar (mobile) */}
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 md:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-[var(--accent-fg)]">
            A
          </div>
          <span className="text-base font-semibold text-[var(--text)]">Applyer</span>
        </div>
        <button
          type="button"
          onClick={() => setNavOpen((v) => !v)}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
          aria-label="Toggle navigation"
        >
          Menu
        </button>
      </header>
      {navOpen && (
        <nav className="flex flex-col gap-1 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-3 md:hidden">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClass} onClick={() => setNavOpen(false)}>
              {item.label}
            </NavLink>
          ))}
          <div className="mt-2 flex items-center justify-between border-t border-[var(--border)] pt-3">
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </div>
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="hidden items-center justify-end border-b border-[var(--border)] bg-[var(--bg-elevated)] px-6 py-3 md:flex">
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--bg-sunken)]"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]">
                {(user?.email ?? '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="max-w-[160px] truncate">{user?.email}</span>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] py-1 shadow-lg">
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="block w-full px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--bg-sunken)]"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>

        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>

        <div className="border-t border-[var(--border)] px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={handleSignOut}
            className="text-sm font-medium text-[var(--danger)]"
          >
            Sign out ({user?.email})
          </button>
        </div>
      </div>
    </div>
  )
}

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <button
      type="button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
    >
      <span>{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
      <span className="text-xs">{theme === 'dark' ? 'Switch to light' : 'Switch to dark'}</span>
    </button>
  )
}
