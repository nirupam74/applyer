import type { AtsReport } from '../lib/types'

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--success)'
  if (score >= 50) return 'var(--warning)'
  return 'var(--danger)'
}

function ScoreRing({ score }: { score: number }) {
  const size = 88
  const stroke = 8
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - score / 100)
  const color = scoreColor(score)

  return (
    <svg width={size} height={size} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={radius} stroke="var(--border)" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize="22" fontWeight="700" fill="var(--text)">
        {score}
      </text>
    </svg>
  )
}

function List({ title, items, tone }: { title: string; items: string[]; tone: 'danger' | 'success' | 'warning' | 'muted' }) {
  const toneClass: Record<string, string> = {
    danger: 'text-[var(--danger)]',
    success: 'text-[var(--success)]',
    warning: 'text-[var(--warning)]',
    muted: 'text-[var(--text-muted)]',
  }
  if (items.length === 0) return null
  return (
    <div>
      <h4 className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${toneClass[tone]}`}>{title}</h4>
      <ul className="flex flex-col gap-1 text-sm text-[var(--text)]">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-[var(--text-muted)]">-</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function AtsCard({ ats }: { ats: AtsReport }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
      <div className="mb-4 flex items-center gap-4">
        <ScoreRing score={ats.score} />
        <div>
          <p className="text-sm font-semibold text-[var(--text)]">ATS score</p>
          <p className="text-sm text-[var(--text-muted)]">Out of 100</p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <List title="Problems" items={ats.problems} tone="danger" />
        <List title="Recommendations" items={ats.recommendations} tone="warning" />
        <List title="Improvements made" items={ats.improvementsMade} tone="success" />
        <List title="Remaining weaknesses" items={ats.remainingWeaknesses} tone="muted" />
        {ats.problems.length === 0 &&
          ats.recommendations.length === 0 &&
          ats.improvementsMade.length === 0 &&
          ats.remainingWeaknesses.length === 0 && (
            <p className="text-sm text-[var(--text-muted)]">No details reported.</p>
          )}
      </div>
    </div>
  )
}
