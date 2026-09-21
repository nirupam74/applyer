import type { Bytes, Timestamp } from 'firebase/firestore'

export interface Task {
  type: 'parseResume' | 'optimizeResume' | 'searchJobs' | 'prepareDocuments' | 'prepareBatch' | 'applyToJob' | 'applyBatch' | 'assistant'
  payload: Record<string, unknown>
  status: 'queued' | 'running' | 'done' | 'failed'
  log: string[]
  error?: string
  result?: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface PersonalInfo {
  name: string
  email: string
  phone: string
  location: string
  linkedin: string
  portfolio: string
  website: string
  links: string[]
}

export interface Education {
  institution: string
  degree: string
  program: string
  major: string
  minor: string
  gpa: string
  graduation: string
  coursework: string[]
}

export interface Experience {
  company: string
  title: string
  employmentType: string
  start: string
  end: string
  responsibilities: string[]
  achievements: string[]
  metrics: string[]
  technologies: string[]
  skills: string[]
  industry: string
}

export interface Project {
  name: string
  description: string
  technologies: string[]
  link: string
}

export interface Skills {
  research: string[]
  laboratory: string[]
  technical: string[]
  tools: string[]
  programming: string[]
  marketing: string[]
  business: string[]
  communication: string[]
  leadership: string[]
  creative: string[]
  industry: string[]
  certifications: string[]
  languages: string[]
}

export interface Preferences {
  titles: string[]
  industries: string[]
  locations: string[]
  remote: 'remote' | 'hybrid' | 'onsite' | 'any'
  employmentType: string[]
  salaryMin: number | null
  seniority: string
}

export interface Profile {
  personal: PersonalInfo
  education: Education[]
  experience: Experience[]
  projects: Project[]
  // Academic CV sections: one line per entry, kept as written (worker resume/extract.js).
  publications?: string[]
  awards?: string[]
  volunteer?: string[]
  skills: Skills
  preferences: Preferences
  workAuthorization: string
  availability: string
  demographics: { citizenship: string; ethnicity: string }
  updatedAt?: Timestamp
}

export interface Resume {
  name: string
  mime: string
  bytes: Bytes
  text?: string
  uploadedAt: Timestamp
}

export interface StructuredResume {
  summary: string
  education: Education[]
  experience: Experience[]
  projects: Project[]
  // Academic CV sections: one line per entry, kept as written (worker resume/extract.js).
  publications?: string[]
  awards?: string[]
  volunteer?: string[]
  skills: Skills
}

export interface AtsReport {
  score: number
  problems: string[]
  recommendations: string[]
  improvementsMade: string[]
  remainingWeaknesses: string[]
}

export interface ResumeVersion {
  resumeId: string
  label: string
  structured: StructuredResume
  ats: AtsReport
  docxBytes: Bytes
  pdfBytes?: Bytes
  pages?: number
  pageLimit?: number
  fits?: boolean
  fileName?: string
  jobId?: string
  createdAt: Timestamp
}

export function emptyProfile(): Profile {
  return {
    personal: {
      name: '',
      email: '',
      phone: '',
      location: '',
      linkedin: '',
      portfolio: '',
      website: '',
      links: [],
    },
    education: [],
    experience: [],
    projects: [],
    skills: {
      research: [],
      laboratory: [],
      technical: [],
      tools: [],
      programming: [],
      marketing: [],
      business: [],
      communication: [],
      leadership: [],
      creative: [],
      industry: [],
      certifications: [],
      languages: [],
    },
    preferences: {
      titles: [],
      industries: [],
      locations: [],
      remote: 'any',
      employmentType: [],
      salaryMin: null,
      seniority: '',
    },
    workAuthorization: '',
    availability: '',
    demographics: { citizenship: '', ethnicity: '' },
  }
}

export interface JobSource {
  name: string
  url: string
  applyUrl: string
}

export interface JobAnalysis {
  matchPct: number | null
  strong: string[]
  missing: string[]
  advantages: string[]
  concerns: string[]
  recommendation: 'apply' | 'maybe' | 'skip'
}

export interface Job {
  title: string
  company: string
  location: string
  workMode: 'remote' | 'hybrid' | 'onsite' | 'unknown'
  salary: string | null
  employmentType: string
  seniority?: string
  description: string
  postedAt: Timestamp | null
  postedText: string | null
  sources: JobSource[]
  score: number
  heuristic: number
  matchPct: number | null
  analysis: JobAnalysis | null
  rank: number | null
  // new/saved/dismissed = triage; applied onward = the user's own applications, tracked by hand
  status: 'new' | 'saved' | 'dismissed' | 'applied' | 'interview' | 'offer' | 'rejected'
  appliedAt?: Timestamp
  notes?: string
  // tailored resume + cover letter made by the worker for this job
  docs?: { resumeVersionId: string; coverLetterId: string; preparedAt: Timestamp }
  // one master resume + cover letter shared by all of this employer's postings
  companyDocs?: { resumeVersionId: string; coverLetterId: string; preparedAt: Timestamp }
  discoveredAt: Timestamp
  updatedAt: Timestamp
}

export interface SourceRun {
  status: 'running' | 'ok' | 'blocked' | 'error'
  message: string
  jobsFound: number
  startedAt?: Timestamp
  finishedAt?: Timestamp
}

export interface ReviewField {
  name: string
  value: string
  confidence: 'green' | 'yellow' | 'red'
}

export interface Application {
  jobId: string
  status: 'preparing' | 'filling' | 'submitted' | 'blocked' | 'needs_human' | 'failed'
  log: string[]
  resumeVersionId?: string
  coverLetterId?: string
  review?: { fields: ReviewField[] }
  screenshots?: Bytes[]
  submittedAt?: Timestamp
  confirmation?: string
  error?: string
  portalUrl?: string
  createdAt: Timestamp
}

export interface CoverLetter {
  jobId: string
  resumeVersionId: string
  text: string
  docxBytes: Bytes
  pdfBytes: Bytes
  fileName: string
  createdAt: Timestamp
}

export interface Answer {
  question: string
  answer: string
  options?: string[] // what the form offered; the Answers page shows them as choices
  tags: string[]
  source: 'user' | 'generated'
  approved: boolean
}

export interface ApplicationSettings {
  email: string
  autoSubmit: boolean
}
