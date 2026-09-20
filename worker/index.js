import admin from 'firebase-admin';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlers } from './handlers.js';

const SA_PATH = process.env.APPLYER_SA || path.join(os.homedir(), '.applyer', 'sa.json');

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(SA_PATH, 'utf8'))),
});

const db = admin.firestore();
const auth = admin.auth();
const FieldValue = admin.firestore.FieldValue;

const watchedUids = new Set();

function log(uid, msg) {
  console.log(`${new Date().toISOString()} [${uid}] ${msg}`);
}

// A restart kills whatever was in flight and leaves its docs saying "running"/"filling" forever.
// Once per uid per process (never on a listener re-attach, which can happen mid-task).
const sweptUids = new Set();
async function sweepInterrupted(uid) {
  if (sweptUids.has(uid)) return;
  sweptUids.add(uid);
  const userRef = db.collection('users').doc(uid);
  const stale = [
    ...(await userRef.collection('tasks').where('status', '==', 'running').get()).docs,
    ...(await userRef.collection('applications').where('status', 'in', ['preparing', 'filling']).get()).docs,
  ];
  for (const d of stale) await d.ref.update({ status: 'failed', error: 'interrupted by a worker restart', updatedAt: FieldValue.serverTimestamp() });
  if (stale.length) log(uid, `marked ${stale.length} interrupted task(s)/application(s) as failed`);
}

async function watchUser(uid) {
  if (watchedUids.has(uid)) return;
  watchedUids.add(uid);
  // Sweep before listening, or a task claimed in between would be swept as stale.
  await sweepInterrupted(uid).catch((err) => log(uid, `sweep failed: ${err.message}`));
  log(uid, 'watching tasks');

  const tasksQuery = db.collection('users').doc(uid).collection('tasks').where('status', '==', 'queued');

  tasksQuery.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added' || change.type === 'modified') {
          claimAndRun(uid, change.doc.ref).catch((err) => {
            log(uid, `unhandled error claiming task ${change.doc.id}: ${err.message}`);
          });
        }
      }
    },
    (err) => {
      log(uid, `tasks listener error: ${err.message}`);
      // An errored listener is dead; forget the uid so the next refreshUsers re-attaches it.
      watchedUids.delete(uid);
    }
  );
}

async function claimAndRun(uid, taskRef) {
  let task = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) return;
    const data = snap.data();
    if (data.status !== 'queued') return;
    tx.update(taskRef, { status: 'running', updatedAt: FieldValue.serverTimestamp() });
    task = { id: snap.id, ...data };
  });

  if (!task) return;

  const appendLog = async (msg) => {
    await taskRef.update({
      log: FieldValue.arrayUnion(`${new Date().toISOString()} ${msg}`),
      updatedAt: FieldValue.serverTimestamp(),
    });
  };

  const handler = handlers[task.type];
  if (!handler) {
    await appendLog(`no handler for task type ${task.type}`);
    await taskRef.update({
      status: 'failed',
      error: `no handler for task type ${task.type}`,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  try {
    await appendLog(`starting ${task.type}`);
    const result = await handler({ db, uid, log: appendLog }, task.payload || {});
    await appendLog('done');
    await taskRef.update({
      status: 'done',
      result: result || {},
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeActivity(uid, task.type, `${task.type} completed`);
  } catch (err) {
    log(uid, `task ${task.id} failed: ${err.message}`);
    try {
      await appendLog(`failed: ${err.message}`);
      await taskRef.update({
        status: 'failed',
        error: err.message,
        updatedAt: FieldValue.serverTimestamp(),
      });
      await writeActivity(uid, task.type, `${task.type} failed: ${err.message}`);
    } catch (writeErr) {
      log(uid, `could not write failure state: ${writeErr.message}`);
    }
  }
}

async function writeActivity(uid, type, message) {
  try {
    await db.collection('users').doc(uid).collection('activity').add({
      type,
      message,
      at: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log(uid, `could not write activity: ${err.message}`);
  }
}

async function refreshUsers() {
  try {
    const list = await auth.listUsers();
    for (const user of list.users) {
      watchUser(user.uid);
    }
  } catch (err) {
    log('worker', `listUsers failed: ${err.message}`);
  }
}

await refreshUsers();
setInterval(refreshUsers, 10 * 60 * 1000);

process.on('uncaughtException', (err) => {
  log('worker', `uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  log('worker', `unhandledRejection: ${err instanceof Error ? err.stack || err.message : err}`);
});

log('worker', 'applyer worker started');
