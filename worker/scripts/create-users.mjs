#!/usr/bin/env node
// Usage: node scripts/create-users.mjs a@x.com b@y.com
// Creates each Auth user with a generated password, seeds users/{uid} and
// users/{uid}/profile/profile. Idempotent: an existing user prints "exists".
import admin from 'firebase-admin';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyProfile } from '../resume/extract.js';

const SA_PATH = process.env.APPLYER_SA || path.join(os.homedir(), '.applyer', 'sa.json');

function generatePassword() {
  return crypto.randomBytes(15).toString('base64url'); // 20 chars
}

async function main() {
  const emails = process.argv.slice(2);
  if (!emails.length) {
    console.error('Usage: node scripts/create-users.mjs a@x.com b@y.com');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(fs.readFileSync(SA_PATH, 'utf8'))),
  });
  const auth = admin.auth();
  const db = admin.firestore();

  for (const email of emails) {
    let userRecord;
    let isNew = false;
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
      const password = generatePassword();
      userRecord = await auth.createUser({ email, password });
      isNew = true;
      console.log(`${email}  ${password}`);
    }

    if (!isNew) {
      console.log(`${email}  exists`);
    }

    const userRef = db.collection('users').doc(userRecord.uid);
    await userRef.set({ email, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await userRef.collection('profile').doc('profile').set(emptyProfile(), { merge: true });
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
