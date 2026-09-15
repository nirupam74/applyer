import { useState, type ReactNode } from 'react'
import type { Education, Experience, Profile, Project, Skills, StructuredResume } from '../lib/types'

export type EditableResume = Profile | StructuredResume

interface ProfileEditorProps<T extends EditableResume> {
  value: T
  onChange: (value: T) => void
}

function hasPersonal(v: EditableResume): v is Profile {
  return 'personal' in v
}

const emptyEducation: Education = {
  institution: '',
  degree: '',
  program: '',
  major: '',
  minor: '',
  gpa: '',
  graduation: '',
  coursework: [],
}

const emptyExperience: Experience = {
  company: '',
  title: '',
  employmentType: '',
  start: '',
  end: '',
  responsibilities: [],
  achievements: [],
  metrics: [],
  technologies: [],
  skills: [],
  industry: '',
}

const emptyProject: Project = { name: '', description: '', technologies: [], link: '' }

const skillLabels: Record<keyof Skills, string> = {
  technical: 'Technical',
  tools: 'Tools',
  programming: 'Programming',
  marketing: 'Marketing',
  business: 'Business',
  communication: 'Communication',
  leadership: 'Leadership',
  creative: 'Creative',
  industry: 'Industry',
  certifications: 'Certifications',
  languages: 'Languages',
}

export default function ProfileEditor<T extends EditableResume>({ value, onChange }: ProfileEditorProps<T>) {
  function set<K extends keyof T>(key: K, v: T[K]) {
    onChange({ ...value, [key]: v })
  }

  return (
    <div className="flex flex-col gap-8">
      {hasPersonal(value) && (
        <Section title="Personal">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Name"
              value={value.personal.name}
              onChange={(v) => set('personal' as keyof T, { ...value.personal, name: v } as T[keyof T])}
            />
            <TextField
              label="Email"
              value={value.personal.email}
              onChange={(v) => set('personal' as keyof T, { ...value.personal, email: v } as T[keyof T])}
            />
            <TextField
              label="Phone"
              value={value.personal.phone}
              onChange={(v) => set('personal' as keyof T, { ...value.personal, phone: v } as T[keyof T])}
            />
            <TextField
              label="Location"
              value={value.personal.location}
              onChange={(v) => set('personal' as keyof T, { ...value.personal, location: v } as T[keyof T])}
            />
            <TextField
              label="LinkedIn"
              value={value.personal.linkedin}
              onChange={(v) => set('personal' as keyof T, { ...value.personal, linkedin: v } as T[keyof T])}
            />
            <TextField
              label="Portfolio"
              value={value.personal.portfolio}
              onChange={(v) => set('personal' as keyof T, { ...value.personal, portfolio: v } as T[keyof T])}
            />
            <TextField
              label="Website"
              value={value.personal.website}
              onChange={(v) => set('personal' as keyof T, { ...value.personal, website: v } as T[keyof T])}
            />
          </div>
          <ChipList
            label="Other links"
            values={value.personal.links}
            onChange={(v) => set('personal' as keyof T, { ...value.personal, links: v } as T[keyof T])}
          />
        </Section>
      )}

      {!hasPersonal(value) && (
        <Section title="Summary">
          <textarea
            value={value.summary}
            onChange={(e) => set('summary' as keyof T, e.target.value as T[keyof T])}
            rows={4}
            className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            placeholder="Professional summary"
          />
        </Section>
      )}

      <Section title="Education">
        <ArrayEditor
          items={value.education}
          empty={emptyEducation}
          onChange={(items) => set('education' as keyof T, items as T[keyof T])}
          addLabel="Add education"
          renderItem={(item, update) => (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField label="Institution" value={item.institution} onChange={(v) => update({ institution: v })} />
              <TextField label="Degree" value={item.degree} onChange={(v) => update({ degree: v })} />
              <TextField label="Program" value={item.program} onChange={(v) => update({ program: v })} />
              <TextField label="Major" value={item.major} onChange={(v) => update({ major: v })} />
              <TextField label="Minor" value={item.minor} onChange={(v) => update({ minor: v })} />
              <TextField label="GPA" value={item.gpa} onChange={(v) => update({ gpa: v })} />
              <TextField label="Graduation" value={item.graduation} onChange={(v) => update({ graduation: v })} />
              <div className="sm:col-span-2">
                <ChipList label="Coursework" values={item.coursework} onChange={(v) => update({ coursework: v })} />
              </div>
            </div>
          )}
        />
      </Section>

      <Section title="Experience">
        <ArrayEditor
          items={value.experience}
          empty={emptyExperience}
          onChange={(items) => set('experience' as keyof T, items as T[keyof T])}
          addLabel="Add experience"
          renderItem={(item, update) => (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField label="Company" value={item.company} onChange={(v) => update({ company: v })} />
                <TextField label="Title" value={item.title} onChange={(v) => update({ title: v })} />
                <TextField label="Employment type" value={item.employmentType} onChange={(v) => update({ employmentType: v })} />
                <TextField label="Industry" value={item.industry} onChange={(v) => update({ industry: v })} />
                <TextField label="Start" value={item.start} onChange={(v) => update({ start: v })} />
                <TextField label="End" value={item.end} onChange={(v) => update({ end: v })} />
              </div>
              <ChipList label="Responsibilities" values={item.responsibilities} onChange={(v) => update({ responsibilities: v })} />
              <ChipList label="Achievements" values={item.achievements} onChange={(v) => update({ achievements: v })} />
              <ChipList label="Metrics" values={item.metrics} onChange={(v) => update({ metrics: v })} />
              <ChipList label="Technologies" values={item.technologies} onChange={(v) => update({ technologies: v })} />
              <ChipList label="Skills used" values={item.skills} onChange={(v) => update({ skills: v })} />
            </div>
          )}
        />
      </Section>

      <Section title="Projects">
        <ArrayEditor
          items={value.projects}
          empty={emptyProject}
          onChange={(items) => set('projects' as keyof T, items as T[keyof T])}
          addLabel="Add project"
          renderItem={(item, update) => (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField label="Name" value={item.name} onChange={(v) => update({ name: v })} />
                <TextField label="Link" value={item.link} onChange={(v) => update({ link: v })} />
              </div>
              <TextField label="Description" value={item.description} onChange={(v) => update({ description: v })} multiline />
              <ChipList label="Technologies" values={item.technologies} onChange={(v) => update({ technologies: v })} />
            </div>
          )}
        />
      </Section>

      <Section title="Skills">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(Object.keys(skillLabels) as (keyof Skills)[]).map((cat) => (
            <ChipList
              key={cat}
              label={skillLabels[cat]}
              values={value.skills[cat]}
              onChange={(v) => set('skills' as keyof T, { ...value.skills, [cat]: v } as T[keyof T])}
            />
          ))}
        </div>
      </Section>

      {hasPersonal(value) && (
        <>
          <Section title="Preferences">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ChipList
                label="Target titles"
                values={value.preferences.titles}
                onChange={(v) => set('preferences' as keyof T, { ...value.preferences, titles: v } as T[keyof T])}
              />
              <ChipList
                label="Industries"
                values={value.preferences.industries}
                onChange={(v) => set('preferences' as keyof T, { ...value.preferences, industries: v } as T[keyof T])}
              />
              <ChipList
                label="Locations"
                values={value.preferences.locations}
                onChange={(v) => set('preferences' as keyof T, { ...value.preferences, locations: v } as T[keyof T])}
              />
              <ChipList
                label="Employment type"
                values={value.preferences.employmentType}
                onChange={(v) => set('preferences' as keyof T, { ...value.preferences, employmentType: v } as T[keyof T])}
              />
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Remote</label>
                <select
                  value={value.preferences.remote}
                  onChange={(e) =>
                    set('preferences' as keyof T, {
                      ...value.preferences,
                      remote: e.target.value as Profile['preferences']['remote'],
                    } as T[keyof T])
                  }
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                >
                  <option value="any">Any</option>
                  <option value="remote">Remote</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="onsite">Onsite</option>
                </select>
              </div>
              <TextField
                label="Seniority"
                value={value.preferences.seniority}
                onChange={(v) => set('preferences' as keyof T, { ...value.preferences, seniority: v } as T[keyof T])}
              />
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Minimum salary</label>
                <input
                  type="number"
                  value={value.preferences.salaryMin ?? ''}
                  onChange={(e) =>
                    set('preferences' as keyof T, {
                      ...value.preferences,
                      salaryMin: e.target.value === '' ? null : Number(e.target.value),
                    } as T[keyof T])
                  }
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>
          </Section>

          <Section title="Other">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label="Work authorization"
                value={value.workAuthorization}
                onChange={(v) => set('workAuthorization' as keyof T, v as T[keyof T])}
              />
              <TextField
                label="Availability"
                value={value.availability}
                onChange={(v) => set('availability' as keyof T, v as T[keyof T])}
              />
            </div>
          </Section>
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}</h3>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  multiline?: boolean
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      )}
    </div>
  )
}

function ChipList({
  label,
  values,
  onChange,
}: {
  label: string
  values: string[]
  onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    if (!v) return
    onChange([...values, v])
    setDraft('')
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">{label}</label>
      <div className="chip-input flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5">
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[var(--accent)]"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((_, idx) => idx !== i))}
              className="text-[var(--accent)] opacity-70 hover:opacity-100"
              aria-label={`Remove ${v}`}
            >
              &times;
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            }
          }}
          onBlur={add}
          placeholder="Add and press Enter"
        />
      </div>
    </div>
  )
}

function ArrayEditor<Item>({
  items,
  empty,
  onChange,
  renderItem,
  addLabel,
}: {
  items: Item[]
  empty: Item
  onChange: (items: Item[]) => void
  renderItem: (item: Item, update: (patch: Partial<Item>) => void, index: number) => ReactNode
  addLabel: string
}) {
  return (
    <div className="flex flex-col gap-4">
      {items.map((item, i) => (
        <div key={i} className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-muted)]">Entry {i + 1}</span>
            <button
              type="button"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              className="text-xs font-medium text-[var(--danger)] hover:underline"
            >
              Remove
            </button>
          </div>
          {renderItem(
            item,
            (patch) => onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it))),
            i,
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, empty])}
        className="self-start rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        + {addLabel}
      </button>
    </div>
  )
}
