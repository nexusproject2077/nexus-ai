// ===============================================================
//  Storage layer — Firestore in production, in-memory in dev.
// ---------------------------------------------------------------
//  Set USE_FIRESTORE=true to persist to Cloud Firestore (Native
//  mode). Otherwise everything lives in memory (handy for local
//  dev; data is lost on restart).
//
//  Cloud Run can use Application Default Credentials. Vercel can
//  use FIREBASE_SERVICE_ACCOUNT_JSON (or the split FIREBASE_* vars).
//  See firebase-admin.js for credential resolution.
// ===============================================================
import { randomUUID } from 'node:crypto';
import { getFirebaseAdmin } from './firebase-admin.js';

const USE_FIRESTORE = process.env.USE_FIRESTORE === 'true';

// ---------------------------------------------------------------
//  IN-MEMORY BACKEND
// ---------------------------------------------------------------
function createMemoryStore() {
  const users = new Map();          // id -> user
  const usersByEmail = new Map();   // email -> user
  const conversations = new Map();  // id -> conv

  return {
    kind: 'memory',
    async usersGetByEmail(email) { return usersByEmail.get(email) || null; },
    async usersGetById(id) { return users.get(id) || null; },
    async usersCreate(user) {
      users.set(user.id, user);
      usersByEmail.set(user.email, user);
      return user;
    },
    async usersSave(user) {
      users.set(user.id, user);
      usersByEmail.set(user.email, user);
      return user;
    },
    async convsListByUser(userId) {
      return [...conversations.values()]
        .filter(c => c.userId === userId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    async convsGet(id) { return conversations.get(id) || null; },
    async convsCreate(conv) { conversations.set(conv._id, conv); return conv; },
    async convsUpdate(id, fields) {
      const c = conversations.get(id);
      if (!c) return null;
      Object.assign(c, fields);
      return c;
    },
    async convsDelete(id) { conversations.delete(id); },
  };
}

// ---------------------------------------------------------------
//  FIRESTORE BACKEND
// ---------------------------------------------------------------
function createFirestoreStore(db) {
  const usersCol = db.collection('users');
  const convsCol = db.collection('conversations');

  const stripUndefined = obj => JSON.parse(JSON.stringify(obj));

  return {
    kind: 'firestore',
    async usersGetByEmail(email) {
      const snap = await usersCol.where('email', '==', email).limit(1).get();
      return snap.empty ? null : snap.docs[0].data();
    },
    async usersGetById(id) {
      const doc = await usersCol.doc(id).get();
      return doc.exists ? doc.data() : null;
    },
    async usersCreate(user) {
      await usersCol.doc(user.id).set(stripUndefined(user));
      return user;
    },
    async usersSave(user) {
      await usersCol.doc(user.id).set(stripUndefined(user), { merge: true });
      return user;
    },
    async convsListByUser(userId) {
      const snap = await convsCol.where('userId', '==', userId).get();
      return snap.docs
        .map(d => d.data())
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    async convsGet(id) {
      const doc = await convsCol.doc(id).get();
      return doc.exists ? doc.data() : null;
    },
    async convsCreate(conv) {
      await convsCol.doc(conv._id).set(stripUndefined(conv));
      return conv;
    },
    async convsUpdate(id, fields) {
      const ref = convsCol.doc(id);
      const doc = await ref.get();
      if (!doc.exists) return null;
      await ref.set(stripUndefined(fields), { merge: true });
      return { ...doc.data(), ...fields };
    },
    async convsDelete(id) { await convsCol.doc(id).delete(); },
  };
}

// ---------------------------------------------------------------
//  FACTORY
// ---------------------------------------------------------------
let _store = null;

export async function getStore() {
  if (_store) return _store;
  if (USE_FIRESTORE) {
    const admin = getFirebaseAdmin();
    _store = createFirestoreStore(admin.firestore());
    console.log('Storage: Firestore');
  } else {
    _store = createMemoryStore();
    console.log('Storage: in-memory (set USE_FIRESTORE=true to persist)');
  }
  return _store;
}

export { randomUUID };
