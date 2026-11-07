import { initializeApp } from 'firebase/app'
import { browserLocalPersistence, getAuth, setPersistence } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: 'applyer-jobs.firebaseapp.com',
  projectId: 'applyer-jobs',
  appId: '1:692780340256:web:4a5eddacb7e8d9f8c55845',
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)

void setPersistence(auth, browserLocalPersistence)
