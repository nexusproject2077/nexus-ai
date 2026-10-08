// ===============================================================
//  NEXUS AI — Backend API (Cloud Run + Vercel ready)
// ---------------------------------------------------------------
//  Reproduces every route the frontend calls:
//    POST   /auth/register        POST   /auth/login
//    POST   /auth/firebase        (social sign-in)
//    GET    /conversations        POST   /conversations
//    PUT    /conversations/:id     DELETE /conversations/:id
//    POST   /chat                 (Groq proxy)
//    GET    /user/settings        PUT    /user/settings
//    PUT    /user/phone
//    PUT    /user/memory          DELETE /user/memory/:index
//
//  Persistence lives in store.js: Cloud Firestore when
//  USE_FIRESTORE=true, in-memory otherwise (dev default).
// ===============================================================

import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getStore, randomUUID } from './store.js';
import { getFirebaseAdmin } from './firebase-admin.js';

const app = express();
app.use(cors({ origin: (origin, callback) => {
  // Keep API usable from local development while allowing credentialed OAuth
  // cookies only for the configured production origin.
  if (!origin || origin === FRONTEND_ORIGIN || /^http:\/\/localhost(?::\d+)?$/.test(origin)) return callback(null, true);
  callback(new Error('Origine non autorisée.'));
}, credentials: true }));
app.use(express.json({ limit: '12mb' })); // messages can carry file text

const PORT        = process.env.PORT || 8080;
const JWT_SECRET  = process.env.JWT_SECRET || 'change-me-in-production';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_URL    = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Google AI Studio exposes an OpenAI-compatible endpoint — same request shape.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || '';
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || 'https://nexus-ai.web.app').replace(/\/$/, '');
const GITHUB_COOKIE_SECRET = process.env.GITHUB_COOKIE_SECRET || JWT_SECRET;

// Allow-listed models → which provider serves them (safety + routing).
const MODEL_PROVIDER = {
  'openai/gpt-oss-120b':    'groq',
  'openai/gpt-oss-20b':      'groq',
  'qwen/qwen3.8-27b':        'groq',
  'gemini-3.8-flash':        'gemini',
  'gemini-3.5-flash-lite':   'gemini',
};

const PROVIDERS = {
  groq:   { url: GROQ_URL,   key: () => GROQ_API_KEY,   label: 'GROQ_API_KEY' },
  gemini: { url: GEMINI_URL, key: () => GEMINI_API_KEY, label: 'GEMINI_API_KEY' },
};

const CODE_SYSTEM_PROMPTS = {
  build: `You are Nexus AI in Code Build mode. Produce production-ready, executable changes that fit the supplied architecture. When work spans files, return a single JSON block tagged nexus-files (no markdown inside it) with this exact shape: {"files":[{"path":"index.html","content":"...","language":"html"}]}. Include every complete generated text file, use relative safe paths only, and keep a short human explanation outside the block. This JSON becomes downloadable project files and a static HTML/CSS/JS preview. Preserve existing contracts unless migration is explicitly requested. Check imports, API shapes, configuration and error paths before answering.`,
  debug: `You are Nexus AI in Code Debug mode. Read logs and code carefully, identify the most likely root cause with evidence, then provide the smallest safe repair. When files are involved, name exact paths and include executable patches or replacement functions. Do not invent successful test results; state concise verification commands and expected outcomes.`,
  explain: `You are Nexus AI in Code Explain mode. Explain code accurately from the supplied context, including data flow, dependencies, risks and side effects. If a change is requested, provide minimal executable edits organized by exact file path. Keep technical terminology precise and distinguish evidence from assumptions.`
};

function codeSystemPrompt(mode) {
  if (!mode || mode.assistantMode !== 'code') return null;
  return CODE_SYSTEM_PROMPTS[mode.codeTask] || CODE_SYSTEM_PROMPTS.build;
}

// Persistence backend (Firestore or in-memory) — see store.js.
const store = await getStore();

// Wrap async route handlers so a rejected promise (e.g. a Firestore
// error) becomes a clean 500 instead of a hung request. Express 4 does
// not catch async errors on its own.
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------
//  HELPERS
// ---------------------------------------------------------------
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email, phone: user.phone || '' };
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
    const i = part.indexOf('=');
    return i < 0 ? [] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(pair => pair.length));
}

function githubCookieOptions(maxAge = 0) {
  return { httpOnly: true, secure: true, sameSite: 'none', path: '/', ...(maxAge ? { maxAge } : {}) };
}

function githubTokenFromRequest(req) {
  const raw = parseCookies(req).nexus_github;
  if (!raw) return null;
  try { return jwt.verify(raw, GITHUB_COOKIE_SECRET).githubToken || null; } catch { return null; }
}

function safePath(value) {
  const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path || path.length > 240 || path.includes('..') || /[\x00-\x1f]/.test(path)) return null;
  return path;
}

function githubHeaders(token) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
}

async function githubRequest(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, { ...options, headers: { ...githubHeaders(token), ...(options.headers || {}) } });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message || `GitHub a répondu ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

// Light phone normalisation/validation: keep +, digits and spaces; 6-20 digits.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^\d+\s().-]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 20) return null;
  return cleaned;
}

// ---------------------------------------------------------------
//  LEGACY MIGRATION — import old MongoDB accounts on first login.
//  The previous backend is still online; when a user logs in with an
//  email we don't have yet, we forward the credentials to the legacy
//  API and, on success, copy the account (with its conversations,
//  settings and memory) into Firestore. The password is re-hashed
//  locally from the plaintext provided at login, so existing passwords
//  keep working. Set LEGACY_API_BASE='' to disable.
// ---------------------------------------------------------------
const LEGACY_API_BASE = (process.env.LEGACY_API_BASE ?? 'https://api.mmi25b11.mmi-troyes.fr').replace(/\/$/, '');

async function legacyFetch(path, opts = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    return await fetch(`${LEGACY_API_BASE}${path}`, { ...opts, headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function migrateFromLegacy(email, password) {
  if (!LEGACY_API_BASE) return null;
  let res;
  try {
    res = await legacyFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  } catch {
    return null;                       // legacy API unreachable
  }
  if (!res.ok) return null;            // wrong credentials on legacy too
  const data = await res.json().catch(() => null);
  if (!data || !data.token || !data.user) return null;

  const legacyToken = data.token;
  const user = {
    id: randomUUID(),
    username: data.user.username || email.split('@')[0],
    email,
    phone: data.user.phone || '',
    passwordHash: await bcrypt.hash(password, 10),
    provider: 'password',
    settings: {},
    memory: [],
    sidebarState: 'visible',
    createdAt: new Date().toISOString(),
    migratedFrom: 'legacy',
  };

  // Pull settings + memory (best-effort)
  try {
    const sRes = await legacyFetch('/user/settings', { method: 'GET' }, legacyToken);
    if (sRes.ok) {
      const s = await sRes.json();
      user.settings = s.settings || {};
      user.memory = s.memory || [];
      if (s.sidebarState) user.sidebarState = s.sidebarState;
    }
  } catch { /* keep defaults */ }

  await store.usersCreate(user);

  // Pull conversations (best-effort)
  try {
    const cRes = await legacyFetch('/conversations', { method: 'GET' }, legacyToken);
    if (cRes.ok) {
      const convs = await cRes.json();
      if (Array.isArray(convs)) {
        for (const c of convs) {
          await store.convsCreate({
            _id: String(c._id || randomUUID()),
            userId: user.id,
            title: c.title || 'Conversation',
            messages: c.messages || [],
            history: c.history || [],
            createdAt: c.createdAt || new Date().toISOString(),
          });
        }
      }
    }
  } catch { /* skip conversations */ }

  return user;
}

// ---------------------------------------------------------------
//  FIREBASE ADMIN (lazy) — verifies social sign-in ID tokens.
//  The shared bootstrap supports Cloud Run ADC and Vercel env secrets.
// ---------------------------------------------------------------
let admin = null;
let firebaseReady = false;
async function ensureFirebase() {
  if (firebaseReady) return true;
  try {
    admin = getFirebaseAdmin();
    firebaseReady = true;
  } catch (e) {
    console.error('Firebase Admin unavailable:', e.message);
  }
  return firebaseReady;
}

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // MongoDB migration compatibility: old Firestore/Firebase sessions can
    // contain a different user id for the same email. Resolve the canonical
    // Mongo account by email so those sessions immediately recover the
    // existing Mongo conversations and settings.
    if (store.kind === 'mongodb' && payload.email) {
      const canonical = await store.usersGetByEmail(payload.email);
      req.user = canonical || { id: payload.id, email: payload.email };
    } else {
      req.user = { id: payload.id, email: payload.email };
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée.' });
  }
}

async function loadCurrentUser(req, res) {
  const user = await store.usersGetById(req.user.id);
  if (!user) {
    res.status(401).json({ error: 'Session invalide.' });
    return null;
  }
  return user;
}

// ---------------------------------------------------------------
//  HEALTH
// ---------------------------------------------------------------
app.get('/', (_req, res) => res.json({ service: 'nexus-ai-backend', ok: true, storage: store.kind }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------
//  AUTH
// ---------------------------------------------------------------
app.post('/auth/register', ah(async (req, res) => {
  const { username, email, password, phone } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'Champs manquants.' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court.' });
  if (await store.usersGetByEmail(email)) return res.status(409).json({ error: 'Cet email est déjà utilisé.' });

  // Phone is optional at register but validated when provided.
  let phoneValue = '';
  if (phone) {
    const p = normalizePhone(phone);
    if (!p) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
    phoneValue = p;
  }

  const user = {
    id: randomUUID(),
    username,
    email,
    phone: phoneValue,
    passwordHash: await bcrypt.hash(password, 10),
    provider: 'password',
    settings: {},
    memory: [],
    sidebarState: 'visible',
    createdAt: new Date().toISOString(),
  };
  await store.usersCreate(user);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

app.post('/auth/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Champs manquants.' });
  let user = await store.usersGetByEmail(email);

  // Unknown email here → maybe an old MongoDB account: migrate on the fly.
  if (!user) {
    user = await migrateFromLegacy(email, password);
    if (user) return res.json({ token: signToken(user), user: publicUser(user) });
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// Social sign-in (Firebase Authentication): the frontend performs the
// Google/GitHub popup, then posts the Firebase ID token here. We verify
// it with Firebase Admin and issue our own app JWT so every other route
// keeps working unchanged.
app.post('/auth/firebase', ah(async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'idToken manquant.' });
  if (!(await ensureFirebase())) {
    return res.status(501).json({ error: 'Connexion sociale non configurée sur le serveur (Firebase Admin indisponible).' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = decoded.email || `${decoded.uid}@firebase.local`;
    let user;
    if (typeof store.usersMergeIdentityIntoEmail === 'function') {
      user = await store.usersMergeIdentityIntoEmail(email, decoded.uid);
    }
    if (!user && typeof store.usersResolveSocialDuplicates === 'function') {
      user = await store.usersResolveSocialDuplicates(email, decoded.uid);
    }
    if (!user) user = await store.usersGetByEmail(email);

    if (!user) {
      user = {
        id: decoded.uid,
        username: decoded.name || (decoded.email ? decoded.email.split('@')[0] : 'user'),
        email,
        phone: '',
        passwordHash: null,
        provider: (decoded.firebase && decoded.firebase.sign_in_provider) || 'firebase',
        settings: {},
        memory: [],
        sidebarState: 'visible',
        createdAt: new Date().toISOString(),
      };
      await store.usersCreate(user);
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    console.error('verifyIdToken failed:', e.message);
    res.status(401).json({ error: 'Jeton Firebase invalide.' });
  }
}));

// ---------------------------------------------------------------
//  GITHUB — OAuth and repository actions. The OAuth access token is
//  kept only in a signed HttpOnly cookie on this API domain;
//  it is never returned to JavaScript or stored in conversation data.
// ---------------------------------------------------------------
app.get('/github/connect', auth, (req, res) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !GITHUB_REDIRECT_URI) {
    return res.status(501).json({ error: 'GitHub OAuth n’est pas configuré sur le serveur.' });
  }
  const state = jwt.sign({ userId: req.user.id, nonce: crypto.randomUUID() }, GITHUB_COOKIE_SECRET, { expiresIn: '10m' });
  res.cookie('nexus_github_state', state, githubCookieOptions(10 * 60 * 1000));
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', GITHUB_REDIRECT_URI);
  url.searchParams.set('scope', 'repo read:user');
  url.searchParams.set('state', state);
  res.json({ url: url.toString() });
});

app.get('/github/callback', ah(async (req, res) => {
  const { code, state } = req.query;
  const stateCookie = parseCookies(req).nexus_github_state;
  if (!code || !state || state !== stateCookie) return res.redirect(`${FRONTEND_ORIGIN}/?github=failed`);
  try {
    jwt.verify(state, GITHUB_COOKIE_SECRET);
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.error_description || 'Autorisation GitHub refusée.');
    const session = jwt.sign({ githubToken: tokenData.access_token }, GITHUB_COOKIE_SECRET, { expiresIn: '7d' });
    res.cookie('nexus_github', session, githubCookieOptions(7 * 24 * 60 * 60 * 1000));
    res.clearCookie('nexus_github_state', githubCookieOptions());
    res.redirect(`${FRONTEND_ORIGIN}/?github=connected`);
  } catch (error) {
    console.error('GitHub OAuth callback:', error.message);
    res.redirect(`${FRONTEND_ORIGIN}/?github=failed`);
  }
}));

app.get('/github/status', auth, ah(async (req, res) => {
  const token = githubTokenFromRequest(req);
  if (!token) return res.json({ connected: false });
  try {
    const profile = await githubRequest('/user', token);
    res.json({ connected: true, login: profile.login, avatarUrl: profile.avatar_url });
  } catch { res.clearCookie('nexus_github', githubCookieOptions()); res.json({ connected: false }); }
}));

app.post('/github/disconnect', auth, (req, res) => {
  res.clearCookie('nexus_github', githubCookieOptions());
  res.json({ ok: true });
});

app.get('/github/repos', auth, ah(async (req, res) => {
  const token = githubTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Connecte GitHub avant de consulter tes dépôts.' });
  const repos = await githubRequest('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', token);
  res.json(repos.map(r => ({ fullName: r.full_name, name: r.name, private: r.private, defaultBranch: r.default_branch, updatedAt: r.updated_at })));
}));

app.get('/github/repos/:owner/:repo/branches', auth, ah(async (req, res) => {
  const token = githubTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Connecte GitHub avant de consulter tes branches.' });
  const branches = await githubRequest(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/branches?per_page=100`, token);
  res.json(branches.map(b => ({ name: b.name, sha: b.commit?.sha })));
}));

app.get('/github/repos/:owner/:repo/file', auth, ah(async (req, res) => {
  const token = githubTokenFromRequest(req);
  const filePath = safePath(req.query.path);
  const ref = String(req.query.ref || 'HEAD');
  if (!token) return res.status(401).json({ error: 'Connecte GitHub avant de lire un fichier.' });
  if (!filePath) return res.status(400).json({ error: 'Chemin de fichier invalide.' });
  const item = await githubRequest(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, token);
  if (Array.isArray(item) || item.type !== 'file') return res.status(400).json({ error: 'Ce chemin ne désigne pas un fichier texte.' });
  const content = Buffer.from(String(item.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  res.json({ path: item.path, sha: item.sha, size: item.size, content });
}));

app.post('/github/repos/:owner/:repo/commit', auth, ah(async (req, res) => {
  const token = githubTokenFromRequest(req);
  const { branch, message, files, confirm } = req.body || {};
  if (!token) return res.status(401).json({ error: 'Connecte GitHub avant toute écriture.' });
  if (confirm !== true) return res.status(400).json({ error: 'Confirmation explicite requise avant la création du commit.' });
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(String(branch || ''))) return res.status(400).json({ error: 'Branche invalide.' });
  if (!Array.isArray(files) || files.length < 1 || files.length > 50) return res.status(400).json({ error: 'Fournis entre 1 et 50 fichiers.' });
  const owner = encodeURIComponent(req.params.owner), repo = encodeURIComponent(req.params.repo);
  const cleanFiles = files.map(f => ({ path: safePath(f.path), content: typeof f.content === 'string' ? f.content : null, sha: typeof f.sha === 'string' ? f.sha : undefined }));
  if (cleanFiles.some(f => !f.path || f.content === null || Buffer.byteLength(f.content, 'utf8') > 1024 * 1024)) return res.status(400).json({ error: 'Fichier invalide ou supérieur à 1 Mo.' });
  // Use Git's blob/tree/commit/ref endpoints so all selected files are written
  // in one atomic commit rather than one commit per file.
  const ref = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  const parentSha = ref.object?.sha;
  const parent = await githubRequest(`/repos/${owner}/${repo}/git/commits/${encodeURIComponent(parentSha)}`, token);
  const tree = [];
  for (const file of cleanFiles) {
    const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs`, token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
    });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const createdTree = await githubRequest(`/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
  });
  const commit = await githubRequest(`/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message || 'Update from Nexus AI').slice(0, 200), tree: createdTree.sha, parents: [parentSha] }),
  });
  await githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  res.json({ ok: true, results: cleanFiles.map(f => ({ path: f.path, commit: commit.sha })) });
}));

// ---------------------------------------------------------------
//  CONVERSATIONS
// ---------------------------------------------------------------
app.get('/conversations', auth, ah(async (req, res) => {
  res.json(await store.convsListByUser(req.user.id));
}));

app.post('/conversations', auth, ah(async (req, res) => {
  const { assistantMode, codeTask } = req.body || {};
  const conv = {
    _id: randomUUID(),
    userId: req.user.id,
    title: 'Nouvelle conversation',
    messages: [],
    history: [],
    pinned: false,
    assistantMode: assistantMode === 'code' ? 'code' : 'chat',
    codeTask: ['build', 'debug', 'explain'].includes(codeTask) ? codeTask : 'build',
    createdAt: new Date().toISOString(),
  };
  await store.convsCreate(conv);
  res.json(conv);
}));

app.put('/conversations/:id', auth, ah(async (req, res) => {
  const conv = await store.convsGet(req.params.id);
  if (!conv || conv.userId !== req.user.id) return res.status(404).json({ error: 'Introuvable.' });
  const { title, messages, history, pinned, assistantMode, codeTask } = req.body || {};
  const fields = {};
  if (title !== undefined) fields.title = title;
  if (messages !== undefined) fields.messages = messages;
  if (history !== undefined) fields.history = history;
  if (pinned !== undefined) fields.pinned = Boolean(pinned);
  if (assistantMode !== undefined) fields.assistantMode = assistantMode === 'code' ? 'code' : 'chat';
  if (codeTask !== undefined) fields.codeTask = ['build', 'debug', 'explain'].includes(codeTask) ? codeTask : 'build';
  fields.updatedAt = new Date().toISOString();
  const updated = await store.convsUpdate(req.params.id, fields);
  res.json(updated);
}));

app.delete('/conversations/:id', auth, ah(async (req, res) => {
  const conv = await store.convsGet(req.params.id);
  if (!conv || conv.userId !== req.user.id) return res.status(404).json({ error: 'Introuvable.' });
  await store.convsDelete(req.params.id);
  res.json({ ok: true });
}));

// Call Gemini's NATIVE endpoint (models/{model}:generateContent?key=...) and
// return an OpenAI-shaped payload, so the frontend needs no changes. We use
// the native endpoint (not the OpenAI-compat one) because API keys pass as a
// query param here, which works with every AI Studio key format.
async function callGeminiNative(model, messages, key) {
  const systemText = messages
    .filter(m => m.role === 'system')
    .map(m => m.content).join('\n\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content ?? '') }],
    }));

  const body = { contents, generationConfig: { temperature: 0.7 } };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await resp.json();
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: (raw && raw.error && raw.error.message) || 'Erreur Gemini.' };
  }
  const parts = (raw.candidates && raw.candidates[0] && raw.candidates[0].content && raw.candidates[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('');
  const u = raw.usageMetadata || {};
  return {
    ok: true,
    data: {
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: u.promptTokenCount,
        completion_tokens: u.candidatesTokenCount,
        total_tokens: u.totalTokenCount,
      },
    },
  };
}

// ---------------------------------------------------------------
//  CHAT — multi-provider proxy (Groq via OpenAI-compat, Gemini native)
// ---------------------------------------------------------------
app.post('/chat', auth, ah(async (req, res) => {
  const { messages, model, mode } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages requis.' });
  const specializedPrompt = codeSystemPrompt(mode);
  const effectiveMessages = specializedPrompt
    ? [{ role: 'system', content: specializedPrompt }, ...messages]
    : messages;

  const chosenModel = MODEL_PROVIDER[model] ? model : DEFAULT_MODEL;
  const providerName = MODEL_PROVIDER[chosenModel];
  const provider = PROVIDERS[providerName];
  const key = provider.key();
  if (!key) {
    return res.status(500).json({ error: `${provider.label} non configurée sur le serveur.` });
  }

  try {
    // ---- Gemini: native endpoint ----
    if (providerName === 'gemini') {
      const r = await callGeminiNative(chosenModel, effectiveMessages, key);
      if (!r.ok) {
        console.error('Gemini error', chosenModel, r.status, r.error);
        const status = (r.status === 401 || r.status === 403) ? 502 : (r.status || 502);
        return res.status(status).json({ error: String(r.error) });
      }
      return res.status(200).json(r.data);
    }

    // ---- Groq (and any OpenAI-compatible provider) ----
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ model: chosenModel, messages: effectiveMessages, temperature: 0.7 }),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('AI provider error', chosenModel, upstream.status, data && data.error);
      // Never surface an upstream 401/403 as-is: the frontend treats any 401
      // as "session expired" and logs the user out. Remap to 502 so the user
      // stays logged in and sees a real message.
      const status = (upstream.status === 401 || upstream.status === 403) ? 502 : upstream.status;
      const message = (data && data.error && (data.error.message || data.error))
        || `Erreur du fournisseur IA. Vérifie la clé ${provider.label}.`;
      return res.status(status).json({ error: String(message) });
    }
    res.status(200).json(data);
  } catch (err) {
    console.error('AI provider error:', err);
    res.status(502).json({ error: 'Erreur de communication avec le fournisseur IA.' });
  }
}));

// ---------------------------------------------------------------
//  USER SETTINGS + PHONE + MEMORY
// ---------------------------------------------------------------
app.get('/user/settings', auth, ah(async (req, res) => {
  const user = await loadCurrentUser(req, res);
  if (!user) return;

  // Bootstrap conversations together with settings. The frontend always loads
  // this endpoint at startup, so Mongo conversations are recovered even if a
  // standalone /conversations request is skipped/cached by the browser.
  const conversations = await store.convsListByUser(user.id);

  res.json({
    user: publicUser(user),
    settings: user.settings || {},
    memory: user.memory || [],
    sidebarState: user.sidebarState || 'visible',
    conversations,
  });
}));

app.put('/user/settings', auth, ah(async (req, res) => {
  const user = await loadCurrentUser(req, res);
  if (!user) return;
  const { settings, sidebarState } = req.body || {};
  if (settings !== undefined) user.settings = settings;
  if (sidebarState !== undefined) user.sidebarState = sidebarState;
  await store.usersSave(user);
  res.json({ ok: true });
}));

// Update the user's phone number (from the login prompt or Settings).
app.put('/user/phone', auth, ah(async (req, res) => {
  const user = await loadCurrentUser(req, res);
  if (!user) return;
  const { phone } = req.body || {};
  if (phone === '' || phone === null) {
    user.phone = '';
  } else {
    const p = normalizePhone(phone);
    if (!p) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
    user.phone = p;
  }
  await store.usersSave(user);
  res.json({ ok: true, user: publicUser(user) });
}));

app.put('/user/memory', auth, ah(async (req, res) => {
  const user = await loadCurrentUser(req, res);
  if (!user) return;
  const { memory } = req.body || {};
  if (Array.isArray(memory)) user.memory = memory;
  await store.usersSave(user);
  res.json({ ok: true, memory: user.memory });
}));

app.delete('/user/memory/:index', auth, ah(async (req, res) => {
  const user = await loadCurrentUser(req, res);
  if (!user) return;
  const i = parseInt(req.params.index, 10);
  if (Number.isInteger(i) && i >= 0 && i < (user.memory || []).length) {
    user.memory.splice(i, 1);
    await store.usersSave(user);
  }
  res.json({ ok: true, memory: user.memory });
}));

// Central error handler — turns any thrown/rejected route error into a
// clean JSON 500 instead of a hung request.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur serveur. Réessaie dans un instant.' });
});

// ---------------------------------------------------------------
// Vercel detects the default-exported Express app. Local/Cloud Run
// execution still starts the HTTP listener normally.
export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Nexus AI backend listening on :${PORT}`));
}
