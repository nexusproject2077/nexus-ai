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
import { MongoClient, ObjectId } from 'mongodb';

const USE_FIRESTORE = process.env.USE_FIRESTORE === 'true';
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'nexusai';

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
//  MONGODB ATLAS BACKEND
// ---------------------------------------------------------------
let _mongoClient = null;

async function createMongoStore(uri, dbName) {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(uri, {
      maxPoolSize: 8,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8000,
    });
    await _mongoClient.connect();
  }

  const db = _mongoClient.db(dbName);
  const usersCol = db.collection('users');
  const convsCol = db.collection('conversations');

  // Keep compatibility with the existing Nexus documents.
  await Promise.allSettled([
    usersCol.createIndex({ email: 1 }, { unique: true, sparse: true }),
    convsCol.createIndex({ userId: 1, updatedAt: -1, createdAt: -1 }),
  ]);

  const cleanUser = doc => {
    if (!doc) return null;
    return {
      ...doc,
      id: doc.id || String(doc._id),
      _id: doc._id ? String(doc._id) : doc._id,
    };
  };

  const cleanConv = doc => {
    if (!doc) return null;
    return {
      ...doc,
      _id: String(doc._id),
      userId: doc.userId != null ? String(doc.userId) : doc.userId,
    };
  };

  const idFilter = id => {
    const values = [id];
    if (ObjectId.isValid(id)) values.push(new ObjectId(id));
    return { _id: { $in: values } };
  };

  return {
    kind: 'mongodb',

    async usersGetByEmail(email) {
      return cleanUser(await usersCol.findOne({ email }));
    },

    async usersGetById(id) {
      return cleanUser(await usersCol.findOne({ $or: [{ id }, ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : [])] }));
    },

    async usersMergeIdentityIntoEmail(email, sourceId) {
      if (!email) return null;

      const normalizedEmail = String(email).trim().toLowerCase();
      let canonicalDoc = await usersCol.findOne({
        $expr: { $eq: [{ $toLower: '$email' }, normalizedEmail] }
      });

      const sourceFilter = sourceId
        ? { $or: [{ id: sourceId }, ...(ObjectId.isValid(sourceId) ? [{ _id: new ObjectId(sourceId) }] : [])] }
        : null;
      const sourceDoc = sourceFilter ? await usersCol.findOne(sourceFilter) : null;

      if (!canonicalDoc && sourceDoc) canonicalDoc = sourceDoc;
      if (!canonicalDoc) return null;

      const canonical = cleanUser(canonicalDoc);
      const canonicalId = canonical.id;

      if (sourceDoc && String(sourceDoc._id) !== String(canonicalDoc._id)) {
        const source = cleanUser(sourceDoc);
        const merged = {
          username: canonical.username || source.username,
          email: canonical.email || source.email || email,
          phone: canonical.phone || source.phone || '',
          settings: { ...(source.settings || {}), ...(canonical.settings || {}) },
          memory: [...new Set([
            ...(Array.isArray(source.memory) ? source.memory : []),
            ...(Array.isArray(canonical.memory) ? canonical.memory : []),
          ])],
          sidebarState: canonical.sidebarState || source.sidebarState || 'visible',
          provider: canonical.provider || source.provider || 'password',
        };
        if (!canonical.passwordHash && source.passwordHash) merged.passwordHash = source.passwordHash;
        await usersCol.updateOne({ _id: canonicalDoc._id }, { $set: { ...merged, id: canonicalId } });
      }

      if (sourceId && sourceId !== canonicalId) {
        const sourceIds = [sourceId];
        if (ObjectId.isValid(sourceId)) sourceIds.push(new ObjectId(sourceId));
        await convsCol.updateMany({ userId: { $in: sourceIds } }, { $set: { userId: canonicalId } });
      }

      const canonicalIds = [canonicalId];
      if (ObjectId.isValid(canonicalId)) canonicalIds.push(new ObjectId(canonicalId));
      await convsCol.updateMany({ userId: { $in: canonicalIds } }, { $set: { userId: canonicalId } });

      return cleanUser(await usersCol.findOne({ _id: canonicalDoc._id }));
    },
    async usersResolveSocialDuplicates(email, preferredId) {
      const docs = await usersCol.find({ email }).toArray();
      if (docs.length <= 1) return cleanUser(docs[0] || null);

      const scored = [];
      for (const doc of docs) {
        const clean = cleanUser(doc);
        const ids = [clean.id, String(doc._id)];
        const queryIds = [...new Set(ids.flatMap(v => {
          const out = [v];
          if (ObjectId.isValid(v)) out.push(new ObjectId(v));
          return out;
        }))];
        const count = await convsCol.countDocuments({ userId: { $in: queryIds } });
        scored.push({ doc, clean, count });
      }

      scored.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        if (a.clean.id === preferredId) return -1;
        if (b.clean.id === preferredId) return 1;
        return new Date(a.clean.createdAt || 0) - new Date(b.clean.createdAt || 0);
      });

      const primary = scored[0];
      const duplicates = scored.slice(1);

      const mergedMemory = [...new Set(scored.flatMap(x => Array.isArray(x.clean.memory) ? x.clean.memory : []))];
      const mergedSettings = Object.assign({}, ...scored.map(x => x.clean.settings || {}));
      const merged = {
        ...primary.clean,
        email,
        memory: mergedMemory,
        settings: mergedSettings,
        phone: primary.clean.phone || scored.find(x => x.clean.phone)?.clean.phone || '',
        sidebarState: primary.clean.sidebarState || scored.find(x => x.clean.sidebarState)?.clean.sidebarState || 'visible',
      };
      delete merged._id;

      // Re-link all conversations from duplicate account IDs to the primary account.
      for (const x of scored) {
        const rawIds = [x.clean.id, String(x.doc._id)];
        const queryIds = [...new Set(rawIds.flatMap(v => {
          const out = [v];
          if (ObjectId.isValid(v)) out.push(new ObjectId(v));
          return out;
        }))];
        await convsCol.updateMany(
          { userId: { $in: queryIds } },
          { $set: { userId: primary.clean.id } }
        );
      }

      const primaryFilter = primary.doc._id instanceof ObjectId
        ? { _id: primary.doc._id }
        : idFilter(primary.clean.id);

      // Delete duplicates first so legacy unique indexes (e.g. username_1)
      // cannot block the final write to the surviving account.
      for (const x of duplicates) {
        await usersCol.deleteOne({ _id: x.doc._id });
      }

      await usersCol.updateOne(
        primaryFilter,
        { $set: { ...merged, id: primary.clean.id } }
      );

      // Recreate the unique email index after duplicate cleanup when possible.
      await usersCol.createIndex({ email: 1 }, { unique: true, sparse: true }).catch(() => {});

      return cleanUser(await usersCol.findOne(primaryFilter));
    },

    async usersCreate(user) {
      await usersCol.updateOne(
        { id: user.id },
        { $setOnInsert: { ...user } },
        { upsert: true }
      );
      return user;
    },

    async usersSave(user) {
      const filter = ObjectId.isValid(user.id)
        ? { $or: [{ id: user.id }, { _id: new ObjectId(user.id) }] }
        : { id: user.id };

      // Never write MongoDB's immutable _id back into $set, and only persist
      // fields Nexus actually edits after account creation.
      const mutable = {
        id: user.id,
        email: user.email,
        phone: user.phone || '',
        settings: user.settings || {},
        memory: Array.isArray(user.memory) ? user.memory : [],
        sidebarState: user.sidebarState || 'visible',
        provider: user.provider || 'password',
      };
      if (user.passwordHash !== undefined) mutable.passwordHash = user.passwordHash;
      // Persist server-managed authentication state, never via /user/settings.
      for (const field of ['sessions', 'sessionVersion', 'twoFactorEnabled', 'totpSecret', 'totpPendingSecret', 'totpLastCounter', 'twoFactorFailures', 'twoFactorLockedUntil', 'twoFactorBackupHashes']) {
        if (user[field] !== undefined) mutable[field] = user[field];
      }

      await usersCol.updateOne(
        filter,
        { $set: mutable },
        { upsert: true }
      );
      return { ...user, ...mutable };
    },

    async convsListByUser(userId) {
      const userIds = [userId];
      if (ObjectId.isValid(userId)) userIds.push(new ObjectId(userId));

      return (await convsCol
        .find({ userId: { $in: userIds } })
        .sort({ updatedAt: -1, createdAt: -1 })
        .toArray())
        .map(cleanConv);
    },

    async convsGet(id) {
      return cleanConv(await convsCol.findOne(idFilter(id)));
    },

    async convsCreate(conv) {
      await convsCol.updateOne(
        { _id: conv._id },
        { $setOnInsert: { ...conv } },
        { upsert: true }
      );
      return conv;
    },

    async convsUpdate(id, fields) {
      const result = await convsCol.findOneAndUpdate(
        idFilter(id),
        { $set: { ...fields } },
        { returnDocument: 'after' }
      );
      return cleanConv(result);
    },

    async convsDelete(id) {
      await convsCol.deleteOne(idFilter(id));
    },
  };
}

// ---------------------------------------------------------------
//  FACTORY
// ---------------------------------------------------------------
let _store = null;

export async function getStore() {
  if (_store) return _store;

  // Prefer MongoDB Atlas whenever a URI is configured. Firestore remains
  // available only as a fallback during migration.
  if (MONGODB_URI) {
    _store = await createMongoStore(MONGODB_URI, MONGODB_DB);
    console.log(`Storage: MongoDB Atlas (${MONGODB_DB})`);
  } else if (USE_FIRESTORE) {
    const admin = getFirebaseAdmin();
    _store = createFirestoreStore(admin.firestore());
    console.log('Storage: Firestore');
  } else {
    _store = createMemoryStore();
    console.log('Storage: in-memory (configure MONGODB_URI for persistence)');
  }

  return _store;
}

export { randomUUID };
