import type { Bytes, Timestamp } from 'firebase/firestore'

export interface Task {
  type: 'parseResume' | 'optimizeResume'
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
  skills: Skills
  preferences: Preferences
  workAuthorization: string
  availability: string
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
  }
}
