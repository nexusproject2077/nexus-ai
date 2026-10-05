// ===============================================================
//  Firebase Admin bootstrap for Cloud Run, Vercel and local dev.
// ---------------------------------------------------------------
//  Credential priority:
//    1) FIREBASE_SERVICE_ACCOUNT_JSON (recommended on Vercel)
//    2) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//    3) Application Default Credentials (Cloud Run / local ADC)
// ===============================================================
import firebaseAdmin from 'firebase-admin';

function serviceAccountFromEnv() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    const raw = JSON.parse(rawJson);
    return {
      projectId: raw.project_id || raw.projectId,
      clientEmail: raw.client_email || raw.clientEmail,
      privateKey: String(raw.private_key || raw.privateKey || '').replace(/\\n/g, '\n'),
    };
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    };
  }

  return null;
}

export function getFirebaseAdmin() {
  if (firebaseAdmin.apps.length) return firebaseAdmin;

  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT;
  const serviceAccount = serviceAccountFromEnv();

  const options = {};
  if (projectId) options.projectId = projectId;
  if (serviceAccount) {
    options.projectId = serviceAccount.projectId || projectId;
    options.credential = firebaseAdmin.credential.cert(serviceAccount);
  }

  firebaseAdmin.initializeApp(options);
  return firebaseAdmin;
}
