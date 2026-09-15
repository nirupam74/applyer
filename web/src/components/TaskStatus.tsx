import { useTask } from '../lib/tasks'

const statusStyles: Record<string, string> = {
  queued: 'bg-[var(--bg-sunken)] text-[var(--text-muted)]',
  running: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  done: 'bg-[var(--success-bg)] text-[var(--success)]',
  failed: 'bg-[var(--danger-bg)] text-[var(--danger)]',
}

export default function TaskStatus({ uid, taskId }: { uid: string; taskId: string }) {
  const { task, loading } = useTask(uid, taskId)

  if (loading) {
    return <p className="text-sm text-[var(--text-muted)]">Loading task...</p>
  }

  if (!task) {
    return <p className="text-sm text-[var(--danger)]">Task not found.</p>
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${statusStyles[task.status]}`}>
          {task.status}
        </span>
        <span className="text-xs text-[var(--text-muted)]">{task.type}</span>
      </div>
      {task.log.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-lg bg-[var(--bg-sunken)] p-2 font-mono text-xs text-[var(--text-muted)]">
          {task.log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {task.status === 'failed' && task.error && (
        <p className="mt-2 text-sm text-[var(--danger)]">{task.error}</p>
      )}
    </div>
  )
}
