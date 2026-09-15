import { collection, doc, type CollectionReference, type DocumentReference } from 'firebase/firestore'
import { db } from '../firebase'

export function userCol(uid: string, name: string): CollectionReference {
  return collection(db, 'users', uid, name)
}

export function userDoc(uid: string, name: string, id: string): DocumentReference {
  return doc(db, 'users', uid, name, id)
}

// Profile is a singleton: collection "profile" holding one document, id "profile".
// (The contract's "users/{uid}/profile" has an odd segment count so cannot be a
// literal document path; this is the standard singleton-subcollection pattern.)
export function profileDoc(uid: string): DocumentReference {
  return userDoc(uid, 'profile', 'profile')
}
