# Nexus AI

Assistant IA (chat) propulsé par Groq. Le dépôt est séparé en deux :

```
frontend/   → site statique (HTML/CSS/JS) déployé sur Firebase Hosting → nexus-ai.web.app
backend/    → API Node/Express (auth, conversations, mémoire, proxy Groq) déployée sur Cloud Run
```

## Frontend

Site statique, aucune étape de build. En local :

```bash
cd frontend
python3 -m http.server 5173      # puis ouvrir http://localhost:5173
```

L'URL de l'API se configure dans [`frontend/js/config.js`](frontend/js/config.js)
(`window.NEXUS_CONFIG.API_BASE`). Par défaut, il pointe sur l'API existante ;
bascule-le sur l'URL Cloud Run quand ton nouveau backend est en ligne.

La **connexion sociale** (Google / GitHub) passe par **Firebase Authentication** :
renseigne [`frontend/js/firebase-config.js`](frontend/js/firebase-config.js) et
suis la section 3 de [DEPLOY.md](DEPLOY.md).

## Mode Code : fichiers, aperçu et GitHub

En Mode Code, Nexus demande désormais à l’IA un bloc `nexus-files` structuré. Le
frontend transforme ce bloc en cartes de fichiers téléchargeables et peut créer
un ZIP localement. Les projets statiques avec `index.html` sont prévisualisés
dans une iframe sandboxée : les CSS et JS locaux référencés sont incorporés pour
l’aperçu. C’est une prévisualisation in-app, pas un serveur localhost sur la
machine de l’utilisateur.

L’intégration GitHub passe exclusivement par le backend. Configure ces variables
secrètes côté hébergeur (jamais dans `frontend/`) :

```text
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_REDIRECT_URI=https://API.example.com/github/callback
GITHUB_COOKIE_SECRET=une-cle-aleatoire-longue
FRONTEND_ORIGIN=https://nexus-ai.web.app
```

Crée une OAuth App GitHub avec l’URL de callback correspondante. Le jeton OAuth
est conservé dans un cookie `HttpOnly`, `Secure`, `SameSite=None` de l’API et ne
transite jamais dans JavaScript. L’UI demande une confirmation avant toute écriture;
les fichiers sont ensuite créés/mis à jour sur la branche choisie via GitHub.

## Backend

```bash
cd backend
cp .env.example .env      # renseigner GROQ_API_KEY + JWT_SECRET
npm install
npm run dev               # http://localhost:8080
```

> Persistance : **Firestore** quand `USE_FIRESTORE=true`, sinon **en mémoire**
> (défaut pratique pour le dev, données perdues au redémarrage). Toute la logique
> est isolée dans [`backend/store.js`](backend/store.js) — voir la section 1 de
> [DEPLOY.md](DEPLOY.md) pour créer la base Firestore.

## Déploiement

Voir **[DEPLOY.md](DEPLOY.md)** pour les commandes complètes (Cloud Build +
Firebase Hosting + Cloud Run).
