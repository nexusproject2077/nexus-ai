# Backend gratuit sur Vercel — Nexus AI

Ce chemin évite Cloud Run / Cloud Build et garde l'architecture actuelle :

- Frontend : Firebase Hosting (`nexus-ai-608af.web.app`)
- Auth : Firebase Authentication
- Données : Cloud Firestore
- Backend Express : Vercel
- IA : Groq / Gemini

## 1. Importer le dépôt dans Vercel

Dans Vercel, importe le dépôt GitHub `nexusproject2077/nexus-ai`.

Dans les paramètres du projet :

- **Root Directory** : `backend`
- **Framework Preset** : laisser la détection automatique / Other
- **Node.js** : 22 ou plus récent

Vercel détecte `server.js` comme application Express. Aucun build command ni output directory n'est nécessaire.

## 2. Variables d'environnement

Ajoute ces variables dans Vercel pour Production, Preview et Development si nécessaire :

```text
USE_FIRESTORE=true
JWT_SECRET=<longue valeur aléatoire>
GROQ_API_KEY=<clé Groq>
GEMINI_API_KEY=<clé Gemini>
FIREBASE_SERVICE_ACCOUNT_JSON=<JSON complet du compte de service Firebase>
LEGACY_API_BASE=https://api.mmi25b11.mmi-troyes.fr
```

`GEMINI_API_KEY` est optionnelle si Gemini n'est pas utilisé.
`LEGACY_API_BASE` peut être vide pour désactiver la migration des anciens comptes.

### Compte de service Firebase

Dans Firebase Console → Project settings → Service accounts, génère une clé privée Firebase Admin.

Ne commit jamais le fichier JSON. Copie son contenu directement dans la variable secrète
`FIREBASE_SERVICE_ACCOUNT_JSON` de Vercel.

Le backend accepte aussi les variables séparées :

```text
FIREBASE_PROJECT_ID=nexus-ai-2077
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
```

## 3. Déployer

Lance le déploiement depuis Vercel. Une fois terminé, teste :

```text
https://<ton-projet>.vercel.app/health
```

La réponse attendue est :

```json
{"ok":true}
```

Puis teste la racine :

```text
https://<ton-projet>.vercel.app/
```

Elle doit indiquer `storage: "firestore"`.

## 4. Brancher le frontend

Dans `frontend/js/config.js`, remplace l'ancienne URL Cloud Run :

```js
API_BASE: 'https://nexus-ai-api-gc555qtsga-ew.a.run.app',
```

par l'URL de production Vercel :

```js
API_BASE: 'https://<ton-projet>.vercel.app',
```

Puis redéploie uniquement Firebase Hosting :

```bash
firebase deploy --only hosting:nexus-ai-608af --project nexus-ai-2077
```

## 5. Connexion sociale

Le frontend continue d'utiliser Firebase Authentication. Le backend Vercel reçoit
l'ID token sur `POST /auth/firebase`, le vérifie avec Firebase Admin, puis émet le
JWT Nexus AI comme avant.

Le middleware CORS Express reste actif pour permettre les requêtes depuis Firebase Hosting.
