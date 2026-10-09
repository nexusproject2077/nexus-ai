// ===== CONFIGURATION =====
const NEXUS_CFG = window.NEXUS_CONFIG || {};
const API_BASE = NEXUS_CFG.API_BASE || 'https://api.mmi25b11.mmi-troyes.fr';
const MODELS = NEXUS_CFG.MODELS || [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 · 70B', hint: '' }];
const TYPING_SPEED = 15;
const TAVILY_KEY = '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';

// ===== ÉTAT MODÈLE (sélecteur Groq) =====
let currentModel = localStorage.getItem('nexus_model') || NEXUS_CFG.DEFAULT_MODEL || MODELS[0].id;
const CODE_TASKS = {
    build: 'Fonctionnalité complète et cohérente',
    debug: 'Diagnostic, cause racine et correctif',
    explain: 'Lecture guidée du code et impacts'
};
if (!MODELS.some(m => m.id === currentModel)) {
    currentModel = NEXUS_CFG.DEFAULT_MODEL || MODELS[0].id;
    localStorage.setItem('nexus_model', currentModel);
}
function currentModelLabel() {
    return (MODELS.find(m => m.id === currentModel) || MODELS[0]).label;
}

// ===== AUTH =====
function getToken() { return localStorage.getItem('nexus_token'); }
function getUser()  { return JSON.parse(localStorage.getItem('nexus_user') || 'null'); }

function setAuth(token, user) {
    localStorage.setItem('nexus_token', token);
    localStorage.setItem('nexus_user', JSON.stringify(user));
}

function clearAuth() {
    localStorage.removeItem('nexus_token');
    localStorage.removeItem('nexus_user');
}

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
    };
}

// ===== SWITCH TAB AUTH =====
window.switchTab = function(tab) {
    document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
    document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
    document.getElementById('tab-login').classList.toggle('active', tab === 'login');
    document.getElementById('tab-register').classList.toggle('active', tab === 'register');
    document.getElementById('login-error').textContent = '';
    document.getElementById('register-error').textContent = '';
};

// ===== LOGIN =====
window.handleLogin = async function() {
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl  = document.getElementById('login-error');
    const btn      = document.getElementById('login-btn');

    if (!email || !password) { errorEl.textContent = 'Remplis tous les champs.'; return; }

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Connexion…';
    errorEl.textContent = '';

    try {
        const res  = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) { errorEl.textContent = data.error || 'Erreur de connexion.'; return; }
        setAuth(data.token, data.user);
        initChatPage();
    } catch {
        errorEl.textContent = 'Impossible de contacter le serveur.';
    } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Se connecter';
    }
};

// ===== REGISTER =====
window.handleRegister = async function() {
    const username = document.getElementById('register-username').value.trim();
    const email    = document.getElementById('register-email').value.trim();
    const phone    = document.getElementById('register-phone').value.trim();
    const password = document.getElementById('register-password').value;
    const errorEl  = document.getElementById('register-error');
    const btn      = document.getElementById('register-btn');

    if (!username || !email || !password) { errorEl.textContent = 'Remplis tous les champs.'; return; }
    if (password.length < 6) { errorEl.textContent = 'Mot de passe trop court (6 caractères min).'; return; }
    if (phone && !isValidPhone(phone)) { errorEl.textContent = 'Numéro de téléphone invalide.'; return; }

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Création…';
    errorEl.textContent = '';

    try {
        const res  = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password, phone })
        });
        const data = await res.json();
        if (!res.ok) { errorEl.textContent = data.error || "Erreur lors de l'inscription."; return; }
        setAuth(data.token, data.user);
        initChatPage();
    } catch {
        errorEl.textContent = 'Impossible de contacter le serveur.';
    } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Créer un compte';
    }
};

// ===== LOGOUT =====
window.handleLogout = function() {
    clearAuth();
    _settingsCache = null;
    conversations = [];
    currentConversationId = null;
    stopConversationSync();
    document.getElementById('chat-page').classList.add('hidden');
    document.getElementById('auth-page').classList.remove('hidden');
};

// ===== INIT =====
function initChatPage() {
    document.getElementById('auth-page').classList.add('hidden');
    document.getElementById('chat-page').classList.remove('hidden');

    consumeGithubOAuthReturn();

    const user = getUser();
    if (user) document.getElementById('sidebar-username').textContent = `@${user.username}`;

    if (window.innerWidth <= 768) {
        sidebar.classList.add('hidden');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('visible');
    } else {
        const savedSidebar = localStorage.getItem('nexus_sidebar');
        if (savedSidebar === 'hidden') sidebar.classList.add('hidden');
    }

    loadSettingsFromServer().finally(() => {
        // Fallback refresh after bootstrap; Mongo bootstrap already restores the
        // sidebar even if this second request is skipped or fails.
        loadConversationsFromServer();
        startConversationSync();
    });
    initModelSelector();
    updateGithubSelectionUI();
}

// ===== ELEMENTS DOM =====
const chatBox           = document.getElementById('chat-box');
const userInput         = document.getElementById('user-input');
const sendButton        = document.getElementById('send-button');
const conversationsList = document.getElementById('conversations-list');
const newChatBtn        = document.getElementById('new-chat-btn');
const sidebar           = document.getElementById('sidebar');
const fileInput         = document.getElementById('file-input');
const attachFileBtn     = document.getElementById('attach-file-btn');
const uploadedFilesDiv  = document.getElementById('uploaded-files');

// ===== ETAT =====
let conversations = [];
let currentConversationId = null;
let attachedFiles = [];
let isTyping = false;
let syncTimer = null;
let lastSyncFingerprint = '';

// ===== DEBOUNCE =====
function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ===== SIDEBAR =====
const toggleSidebarInside  = document.getElementById('toggle-sidebar-inside');
const toggleSidebarOutside = document.getElementById('toggle-sidebar-outside');
const sidebarBackdrop      = document.getElementById('sidebar-backdrop');

function isMobile() { return window.innerWidth <= 768; }

function openSidebar() {
    sidebar.classList.remove('hidden');
    localStorage.setItem('nexus_sidebar', 'visible');
    if (isMobile() && sidebarBackdrop) sidebarBackdrop.classList.add('visible');
    saveSidebarStateToServer('visible');
}

function closeSidebar() {
    sidebar.classList.add('hidden');
    localStorage.setItem('nexus_sidebar', 'hidden');
    if (sidebarBackdrop) sidebarBackdrop.classList.remove('visible');
    saveSidebarStateToServer('hidden');
}

window.closeSidebarMobile = closeSidebar;

if (toggleSidebarInside)  toggleSidebarInside.addEventListener('click',  closeSidebar);
if (toggleSidebarOutside) toggleSidebarOutside.addEventListener('click', openSidebar);

if (conversationsList) {
    conversationsList.addEventListener('click', () => {
        if (isMobile()) closeSidebar();
    });
}

// ===== FICHIERS / MENU + =====
const composerPlusMenu = document.getElementById('composer-plus-menu');
const plusUploadBtn = document.getElementById('plus-upload-btn');

function closeComposerPlusMenu() {
    composerPlusMenu?.classList.add('hidden');
}

if (attachFileBtn) {
    attachFileBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        composerPlusMenu?.classList.toggle('hidden');
        if (!composerPlusMenu?.classList.contains('hidden')) refreshGithubStatus();
    });
}
if (plusUploadBtn) {
    plusUploadBtn.addEventListener('click', () => {
        closeComposerPlusMenu();
        fileInput?.click();
    });
}
document.addEventListener('click', (event) => {
    if (!composerPlusMenu || composerPlusMenu.classList.contains('hidden')) return;
    if (!event.target.closest('.composer-plus-wrap')) closeComposerPlusMenu();
});

if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            const ext = file.name.split('.').pop().toLowerCase();
            const isImage = file.type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext);

            if (isImage) {
                // Afficher miniature immédiatement, analyser en arrière-plan
                const dataUrl = await readAsDataURL(file);
                const info    = await getImageDimensions(dataUrl);
                const partial = {
                    name: file.name, type: file.type, size: file.size,
                    kind: 'image', preview: dataUrl, content: null,
                    description: `${info.width}x${info.height}px · analyse en cours…`
                };
                attachedFiles.push(partial);
                renderUploadedFiles();

                try {
                    const colors  = await analyzeImageColors(dataUrl);
                    const caption = await captionImageWithHF(dataUrl, file.type);
                    let content = `[Image jointe : ${file.name}]\nDimensions : ${info.width}x${info.height}px\nLuminosite : ${colors.luminosityLabel} (${colors.brightness}/255)\nCouleur dominante : ${colors.avgColor}`;
                    if (caption) content += `\n\nDescription du contenu :\n${caption}`;
                    const desc = caption
                        ? `${info.width}x${info.height}px - "${caption.substring(0, 60)}${caption.length > 60 ? '...' : ''}"`
                        : `${info.width}x${info.height}px - analyse visuelle`;
                    partial.content     = content;
                    partial.description = desc;
                } catch {
                    partial.content     = `[Image : ${file.name}]\nDimensions : ${info.width}x${info.height}px`;
                    partial.description = `${info.width}x${info.height}px`;
                }
                renderUploadedFiles();
            } else {
                const placeholder = { name: file.name, type: file.type, size: file.size, kind: 'loading', content: null };
                attachedFiles.push(placeholder);
                renderUploadedFiles();
                try {
                    const extracted = await readFileContent(file);
                    const idx = attachedFiles.indexOf(placeholder);
                    if (idx !== -1) attachedFiles[idx] = extracted;
                } catch {
                    const idx = attachedFiles.indexOf(placeholder);
                    if (idx !== -1) attachedFiles[idx] = { name: file.name, type: file.type, size: file.size, kind: 'error', content: null };
                }
                renderUploadedFiles();
            }
        }
        fileInput.value = '';
    });
}

// ===== FILE READING & EXTRACTION =====
function readAsText(file)        { return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsText(file); }); }
function readAsDataURL(file)     { return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(file); }); }
function readAsArrayBuffer(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsArrayBuffer(file); }); }

async function readFileContent(file) {
    const base = { name: file.name, type: file.type, size: file.size };
    const ext = file.name.split('.').pop().toLowerCase();

    if (file.type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) {
        const dataUrl = await readAsDataURL(file);
        const info    = await getImageDimensions(dataUrl);
        const colors  = await analyzeImageColors(dataUrl);

        // Try HF BLIP captioning (free, no auth required for public models)
        let caption = await captionImageWithHF(dataUrl, file.type);

        // Build rich text description for the AI
        let content = `[Image jointe : ${file.name}]\nDimensions : ${info.width}×${info.height}px\nLuminosité : ${colors.luminosityLabel} (${colors.brightness}/255)\nCouleur dominante : ${colors.avgColor}`;
        if (caption) content += `\n\nDescription du contenu :\n${caption}`;

        const desc = caption
            ? `${info.width}×${info.height}px · "${caption.substring(0, 60)}${caption.length > 60 ? '…' : ''}"`
            : `${info.width}×${info.height}px · analyse visuelle`;

        return { ...base, kind: 'image', content, preview: dataUrl, description: desc };
    }

    if (file.type.startsWith('text/') || ['txt','csv','md','json','xml','html','js','ts','py','java','c','cpp','css'].includes(ext)) {
        const text = await readAsText(file);
        return { ...base, kind: 'text', content: text, description: `Texte (${text.split('\n').length} lignes)` };
    }

    if (file.type === 'application/pdf' || ext === 'pdf') {
        const text = await extractPDFText(file);
        return { ...base, kind: 'text', content: text, description: `PDF extrait (${text.split('\n').length} lignes)` };
    }

    if (['xlsx','xls','ods'].includes(ext) || file.type.includes('spreadsheet') || file.type.includes('excel')) {
        const text = await extractExcelText(file);
        return { ...base, kind: 'text', content: text, description: `Tableau extrait` };
    }

    if (['docx'].includes(ext) || file.type.includes('wordprocessingml')) {
        const text = await extractWordText(file);
        return { ...base, kind: 'text', content: text, description: `Document extrait (${text.split('\n').length} lignes)` };
    }

    try {
        const text = await readAsText(file);
        return { ...base, kind: 'text', content: text };
    } catch {
        return { ...base, kind: 'binary', content: null, description: 'Fichier binaire non lisible' };
    }
}

function getImageDimensions(dataUrl) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload  = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ width: 0, height: 0 });
        img.src = dataUrl;
    });
}

function compressImage(dataUrl, maxWidth = 1024, quality = 0.75) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let w = img.naturalWidth;
            let h = img.naturalHeight;
            if (w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

function analyzeImageColors(dataUrl) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 80; canvas.height = 80;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, 80, 80);
                const data = ctx.getImageData(0, 0, 80, 80).data;
                let r = 0, g = 0, b = 0, br = 0;
                const n = data.length / 4;
                for (let i = 0; i < data.length; i += 4) {
                    r += data[i]; g += data[i+1]; b += data[i+2];
                    br += data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
                }
                r = Math.round(r/n); g = Math.round(g/n); b = Math.round(b/n);
                br = Math.round(br/n);
                const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
                const luminosityLabel = br < 80 ? 'sombre' : br < 170 ? 'moyen' : 'clair';
                resolve({ avgColor: hex, brightness: br, luminosityLabel });
            } catch { resolve({ avgColor: '#888888', brightness: 128, luminosityLabel: 'moyen' }); }
        };
        img.onerror = () => resolve({ avgColor: '#888888', brightness: 128, luminosityLabel: 'moyen' });
        img.src = dataUrl;
    });
}

function dataURLtoBlob(dataUrl) {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const bytes = atob(data);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

async function captionImageWithHF(dataUrl, mimeType) {
    try {
        const blob = dataURLtoBlob(dataUrl);
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await fetch(
                'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large',
                { method: 'POST', headers: { 'Content-Type': mimeType || 'image/jpeg' }, body: blob }
            );
            if (res.ok) {
                const json = await res.json();
                return (Array.isArray(json) ? json[0]?.generated_text : json?.generated_text) || null;
            }
            if (res.status === 503 && attempt === 0) {
                await new Promise(r => setTimeout(r, 4000));
                continue;
            }
            break;
        }
        return null;
    } catch { return null; }
}

async function extractPDFText(file) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js non charge');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const buffer = await readAsArrayBuffer(file);
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const pages = [];
    const maxPages = Math.min(pdf.numPages, 80);
    for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const lineMap = {};
        content.items.forEach(item => {
            const y = Math.round(item.transform[5]);
            lineMap[y] = (lineMap[y] || '') + item.str + ' ';
        });
        const pageText = Object.keys(lineMap).sort((a,b) => b-a).map(y => lineMap[y].trim()).join('\n');
        pages.push(`--- Page ${i} ---\n${pageText}`);
    }
    if (pdf.numPages > maxPages) pages.push(`[${pdf.numPages - maxPages} page(s) tronquees]`);
    return pages.join('\n\n');
}

async function extractExcelText(file) {
    if (typeof XLSX === 'undefined') throw new Error('SheetJS non charge');
    const buffer = await readAsArrayBuffer(file);
    const workbook = XLSX.read(buffer, { type: 'array' });
    return workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return `=== Feuille : ${name} ===\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join('\n\n');
}

async function extractWordText(file) {
    if (typeof mammoth === 'undefined') throw new Error('mammoth.js non charge');
    const buffer = await readAsArrayBuffer(file);
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value;
}

// Premium line-icons (SVG) — replaces emoji file glyphs
const FILE_SVG = {
    doc:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
    pdf:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 17v-3h1a1 1 0 0 1 0 2h-1M13 17v-3h1.2M13 15.5h1"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-4.5-4.5L6 21"/></svg>',
    sheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
    json:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3a3 3 0 0 0-3 3v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a3 3 0 0 0 3 3M16 3a3 3 0 0 1 3 3v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a3 3 0 0 1-3 3"/></svg>',
    file:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3.33 3.33 0 0 1 4.71 4.71l-9.2 9.19a1.67 1.67 0 0 1-2.36-2.36l8.49-8.48"/></svg>',
};

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
        txt: 'doc', md: 'doc', doc: 'doc', docx: 'doc',
        pdf: 'pdf',
        jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
        xlsx: 'sheet', xls: 'sheet', csv: 'sheet', ods: 'sheet',
        json: 'json',
    };
    return FILE_SVG[map[ext]] || FILE_SVG.file;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderUploadedFiles() {
    if (!uploadedFilesDiv) return;
    uploadedFilesDiv.innerHTML = '';
    attachedFiles.forEach((file, index) => {
        const fileEl = document.createElement('div');
        fileEl.className = 'uploaded-file' + (file.kind === 'loading' ? ' file-loading' : '');

        if (file.kind === 'image' && file.preview) {
            const badge = file.content
                ? '<span class="file-badge ok">analysable</span>'
                : '<span class="file-badge extracting">analyse IA…</span>';
            fileEl.innerHTML = `
                <img src="${file.preview}" class="file-thumb" alt="${file.name}">
                <div class="file-info">
                    <span class="file-name" title="${file.name}">${file.name}</span>
                    <span class="file-meta">${file.description || formatFileSize(file.size)}</span>
                </div>
                ${badge}
                <span class="remove-file" onclick="removeFile(${index})">×</span>
            `;
        } else {
            const statusBadge = file.kind === 'loading'
                ? '<span class="file-badge extracting">extraction…</span>'
                : (file.kind === 'text' || file.kind === 'image') && file.content
                ? '<span class="file-badge ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>analysable</span>'
                : file.kind === 'error'
                ? '<span class="file-badge err">erreur</span>'
                : '';
            fileEl.innerHTML = `
                <span class="file-icon">${getFileIcon(file.name)}</span>
                <div class="file-info">
                    <span class="file-name" title="${file.name}">${file.name}</span>
                    <span class="file-meta">${file.description || formatFileSize(file.size)}</span>
                </div>
                ${statusBadge}
                <span class="remove-file" onclick="removeFile(${index})">×</span>
            `;
        }
        uploadedFilesDiv.appendChild(fileEl);
    });
}

window.removeFile = function(index) {
    attachedFiles.splice(index, 1);
    renderUploadedFiles();
};

// ===== SYNCHRONISATION MULTI-APPAREILS =====
function normalizeConversation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        ...raw,
        _id: String(raw._id ?? ''),
        title: String(raw.title || 'Nouvelle conversation'),
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        history: Array.isArray(raw.history) ? raw.history : [],
        pinned: !!raw.pinned,
        assistantMode: raw.assistantMode === 'code' ? 'code' : 'chat',
        codeTask: Object.hasOwn(CODE_TASKS, raw.codeTask) ? raw.codeTask : 'build',
        createdAt: raw.createdAt || raw.updatedAt || new Date().toISOString(),
    };
}

function normalizeConversationList(list) {
    return (Array.isArray(list) ? list : [])
        .map(normalizeConversation)
        .filter(c => c && c._id);
}

// Uses the existing API/Firestore storage, so no extra paid service is required.
function conversationFingerprint(list) {
    return JSON.stringify((list || []).map(c => [c._id, c.title, c.updatedAt || c.createdAt, (c.messages || []).length]));
}

let lastConversationSyncAt = 0;

async function syncConversationsFromServer(force = false) {
    if (!getToken() || document.hidden || isTyping) return;
    const now = Date.now();
    if (!force && now - lastConversationSyncAt < 15000) return;
    lastConversationSyncAt = now;
    try {
        const res = await fetch(`${API_BASE}/conversations`, { headers: authHeaders(), cache: 'no-store' });
        if (!res.ok) return;
        const remote = normalizeConversationList(await res.json());
        const fingerprint = conversationFingerprint(remote);
        if (fingerprint === lastSyncFingerprint) return;

        const activeId = currentConversationId;
        const activeBefore = conversations.find(c => c._id === activeId);
        const activeRemote = remote.find(c => c._id === activeId);
        const localDraft = conversations.find(c => c._localDraft);
        conversations = localDraft ? [localDraft, ...remote] : remote;
        lastSyncFingerprint = fingerprint;

        renderConversationsList();

        // Never replace an unsent local draft with server state.
        if (localDraft && activeId === localDraft._id) return;

        // Refresh the open conversation only when its server version actually changed.
        if (activeRemote) {
            const before = JSON.stringify(activeBefore?.messages || []);
            const after = JSON.stringify(activeRemote.messages || []);
            if (before !== after) loadConversation(activeId);
        } else if (remote.length && activeId) {
            loadConversation(remote[0]._id);
        }
    } catch (err) {
        console.debug('Sync conversations:', err);
    }
}

function startConversationSync() {
    stopConversationSync();
    // Firestore free tier protection: no aggressive polling.
    // Device switching still syncs immediately on focus/visibility.
    syncTimer = setInterval(syncConversationsFromServer, 60000);
}

function stopConversationSync() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && getToken()) syncConversationsFromServer(true);
});

window.addEventListener('focus', () => {
    if (getToken()) syncConversationsFromServer(true);
});

// ===== API CONVERSATIONS =====
async function loadConversationsFromServer() {
    let remote;
    try {
        const res = await fetch(`${API_BASE}/conversations`, {
            headers: authHeaders(),
            cache: 'no-store'
        });
        if (res.status === 401) { handleLogout(); return; }
        if (!res.ok) throw new Error(`Chargement conversations impossible (${res.status})`);
        remote = normalizeConversationList(await res.json());
    } catch (err) {
        console.error('Erreur chargement conversations:', err);
        if (!conversations.length) createNewConversation();
        showToast('Impossible de charger les conversations. Réessaie dans un instant.', 'error', 3500);
        return;
    }

    conversations = remote;
    lastSyncFingerprint = conversationFingerprint(conversations);
    renderConversationsList();

    if (conversations.length === 0) {
        createNewConversation();
        return;
    }

    try {
        await loadConversation(conversations[0]._id);
    } catch (err) {
        console.error('Erreur affichage conversation:', err);
        renderConversationsList();
    }
}

function createNewConversation() {
    // A new chat stays entirely local until the user sends the first message.
    // This prevents empty conversations from being stored in Firestore.
    conversations = conversations.filter(c => !c._localDraft);

    const draft = {
        _id: `draft-${Date.now()}`,
        title: 'Nouvelle conversation',
        messages: [],
        history: [],
        pinned: false,
        assistantMode: 'chat',
        codeTask: 'build',
        createdAt: new Date().toISOString(),
        _localDraft: true
    };

    conversations.unshift(draft);
    loadConversation(draft._id);
    renderConversationsList();
}

async function ensureCurrentConversationPersisted() {
    const draft = getCurrentConversation();
    if (!draft) return null;
    if (!draft._localDraft) return draft;

    try {
        const res = await fetch(`${API_BASE}/conversations`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                assistantMode: draft.assistantMode,
                codeTask: draft.codeTask
            })
        });
        if (!res.ok) throw new Error('Creation conversation impossible.');

        const persisted = await res.json();
        const index = conversations.findIndex(c => c._id === draft._id);
        if (index !== -1) conversations[index] = persisted;
        currentConversationId = persisted._id;
        lastSyncFingerprint = '';

        renderConversationsList();
        return persisted;
    } catch (err) {
        console.error('Erreur creation conversation:', err);
        showToast('Impossible de creer la conversation.', 'error');
        return null;
    }
}

async function saveConversationToServer(conv) {
    if (!conv || conv._localDraft) return false;
    try {
        const res = await fetch(`${API_BASE}/conversations/${conv._id}`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ title: conv.title, messages: conv.messages, history: conv.history, pinned: !!conv.pinned, assistantMode: conv.assistantMode, codeTask: conv.codeTask })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Sauvegarde impossible (${res.status})`);
        }
        lastSyncFingerprint = '';
        return true;
    } catch (err) {
        console.error('Erreur sauvegarde:', err);
        showToast('Conversation non sauvegardée. Nouvelle tentative au prochain envoi.', 'error', 3500);
        return false;
    }
}

const debouncedSave = debounce(saveConversationToServer, 900);

window.deleteConversation = async function(id, event) {
    event.stopPropagation();
    if (!confirm('Supprimer cette conversation ?')) return;

    const local = conversations.find(c => c._id === id && c._localDraft);
    if (local) {
        conversations = conversations.filter(c => c._id !== id);
        if (currentConversationId === id) {
            if (conversations.length === 0) createNewConversation();
            else loadConversation(conversations[0]._id);
        }
        renderConversationsList();
        return;
    }

    try {
        await fetch(`${API_BASE}/conversations/${id}`, { method: 'DELETE', headers: authHeaders() });
        conversations = conversations.filter(c => c._id !== id);
        if (currentConversationId === id) {
            if (conversations.length === 0) await createNewConversation();
            else loadConversation(conversations[0]._id);
        }
        renderConversationsList();
    } catch (err) {
        console.error('Erreur suppression:', err);
    }
};

async function loadConversation(id) {
    currentConversationId = id;
    const conv = conversations.find(c => c._id === id);
    if (!conv) return;
    const titleEl = document.getElementById('current-conversation-title');
    if (titleEl) titleEl.textContent = conv.title || 'Nouvelle conversation';
    refreshAssistantModeUI(conv);

    // Avoid briefly showing the beginning of a long conversation while it is restored.
    chatBox.style.visibility = 'hidden';
    chatBox.innerHTML = '';

    const safeMessages = Array.isArray(conv.messages) ? conv.messages : [];
    for (const msg of safeMessages) {
        const role = msg?.type || msg?.role || msg?.sender || '';
        const content = msg?.content ?? msg?.text ?? msg?.message ?? '';
        if (!content) continue;
        if (role === 'user' || role === 'human') await addMessage('user-message', String(content), false, false);
        else await addMessage('bot-message', String(content), true, false);
    }

    if (safeMessages.length === 0) renderEmptyState();
    renderConversationsList();

    const restoredId = id;
    const revealAtBottom = () => {
        if (currentConversationId !== restoredId) return;

        // Scroll every actual conversation/page scroll container to its exact
        // maximum (scrollHeight - clientHeight), rather than estimating a page Y.
        const page = document.scrollingElement || document.documentElement;
        const main = document.getElementById('main-content');
        for (const el of [chatBox, main, page, document.body, document.documentElement]) {
            if (el && el.scrollHeight > el.clientHeight) {
                el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
            }
        }
        chatBox.style.visibility = 'visible';
    };

    // Fonts and Markdown tables can change document height after rendering.
    // Keep scrolling to the exact end briefly while the layout stabilizes.
    requestAnimationFrame(() => requestAnimationFrame(revealAtBottom));
    [100, 300, 650, 1200].forEach(delay => setTimeout(revealAtBottom, delay));
    if (document.fonts?.ready) {
        document.fonts.ready.then(revealAtBottom).catch(() => {});
    }
}

function getCurrentConversation() {
    return conversations.find(c => c._id === currentConversationId);
}

function updateConversationTitle(message) {
    const conv = getCurrentConversation();
    if (conv && conv.messages.length === 1) {
        conv.title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
        const titleEl = document.getElementById('current-conversation-title');
        if (titleEl) titleEl.textContent = conv.title;
        renderConversationsList();
        saveConversationToServer(conv);
    }
}

function closeConversationMenus() {
    document.querySelectorAll('.conversation-actions-menu').forEach(menu => menu.classList.add('hidden'));
}

window.toggleConversationMenu = function(id, event) {
    event.stopPropagation();
    const menu = document.getElementById('conv-menu-' + id);
    const wasHidden = menu?.classList.contains('hidden');
    closeConversationMenus();
    if (menu && wasHidden) menu.classList.remove('hidden');
};

function beginConversationTitleEdit() {
    const conv = getCurrentConversation();
    const bar = document.getElementById('conversation-title-bar');
    const titleEl = document.getElementById('current-conversation-title');
    if (!conv || !bar || !titleEl || bar.classList.contains('editing')) return;

    const original = conv.title || 'Nouvelle conversation';
    bar.classList.add('editing');
    bar.innerHTML = '<input id="conversation-title-input" class="conversation-title-input" type="text" maxlength="100" aria-label="Titre de la conversation">';

    const input = document.getElementById('conversation-title-input');
    input.value = original;
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
        if (finished) return;
        finished = true;

        const value = (input.value || '').trim();
        const nextTitle = save && value ? value.slice(0, 100) : original;

        if (save && nextTitle !== original) {
            conv.title = nextTitle;
            renderConversationsList();
            await saveConversationToServer(conv);
        }

        bar.classList.remove('editing');
        bar.innerHTML = '<span id="current-conversation-title" class="current-conversation-title"></span><svg class="conversation-title-edit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
        const restored = document.getElementById('current-conversation-title');
        if (restored) restored.textContent = conv.title || original;
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
        }
    });
    input.addEventListener('blur', () => finish(true));
}

const conversationTitleBar = document.getElementById('conversation-title-bar');
if (conversationTitleBar) {
    conversationTitleBar.addEventListener('click', () => beginConversationTitleEdit());
}

window.renameConversation = async function(id, event) {
    event?.stopPropagation();
    closeConversationMenus();
    const conv = conversations.find(c => c._id === id);
    if (!conv) return;
    const title = prompt('Renommer la conversation', conv.title);
    if (title === null) return;
    const clean = title.trim();
    if (!clean) return;
    conv.title = clean.slice(0, 100);
    if (currentConversationId === id) {
        const titleEl = document.getElementById('current-conversation-title');
        if (titleEl) titleEl.textContent = conv.title;
    }
    renderConversationsList();
    await saveConversationToServer(conv);
};

window.togglePinConversation = async function(id, event) {
    event?.stopPropagation();
    closeConversationMenus();
    const conv = conversations.find(c => c._id === id);
    if (!conv) return;
    conv.pinned = !conv.pinned;
    renderConversationsList();
    await saveConversationToServer(conv);
};

function renderConversationsList() {
    if (!conversationsList) return;
    conversationsList.innerHTML = '';
    const savedConversations = conversations.filter(c => !c._localDraft);
    let filtered = searchQuery
        ? savedConversations.filter(c => String(c.title || '').toLowerCase().includes(searchQuery.toLowerCase()))
        : [...savedConversations];
    filtered.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
    if (filtered.length === 0 && searchQuery) {
        conversationsList.innerHTML = '<p style="color:rgba(255,255,255,0.35);font-size:0.78rem;text-align:center;padding:16px 0">Aucun resultat</p>';
        return;
    }

    const pinIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M5 17h14"/><path d="M6 3h12l-2 8 3 3H5l3-3Z"/></svg>';
    const editIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
    const trashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
    const moreIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';

    filtered.forEach(conv => {
        const item = document.createElement('div');
        item.className = 'conversation-item' + (conv._id === currentConversationId ? ' active' : '') + (conv.pinned ? ' pinned' : '');
        const date = new Date(conv.createdAt);
        const dateStr = date.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'2-digit' });
        const timeStr = date.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
        item.innerHTML = `
            <div class="conversation-title-row">
                ${conv.pinned ? '<span class="conversation-pin-indicator">' + pinIcon + '</span>' : ''}
                <div class="conversation-title">${escapeMemoryHTML(conv.title)}</div>
            </div>
            <div class="conversation-date">${dateStr} ${timeStr}</div>
            <button class="conversation-more-btn" onclick="toggleConversationMenu('${conv._id}', event)" aria-label="Actions">${moreIcon}</button>
            <div class="conversation-actions-menu hidden" id="conv-menu-${conv._id}" onclick="event.stopPropagation()">
                <button onclick="togglePinConversation('${conv._id}', event)">${pinIcon}<span>${conv.pinned ? 'Desepingler' : 'Epingler'}</span></button>
                <button onclick="renameConversation('${conv._id}', event)">${editIcon}<span>Renommer</span></button>
                <button class="danger" onclick="deleteConversation('${conv._id}', event)">${trashIcon}<span>Supprimer</span></button>
            </div>
        `;
        item.addEventListener('click', () => { closeConversationMenus(); loadConversation(conv._id); });

        let pressTimer = null;
        item.addEventListener('pointerdown', e => {
            if (e.target.closest('button') || e.pointerType === 'mouse') return;
            pressTimer = setTimeout(() => toggleConversationMenu(conv._id, { stopPropagation(){} }), 520);
        });
        ['pointerup','pointercancel','pointerleave'].forEach(type => item.addEventListener(type, () => {
            if (pressTimer) clearTimeout(pressTimer);
            pressTimer = null;
        }));
        conversationsList.appendChild(item);
    });
}

document.addEventListener('click', closeConversationMenus);

if (newChatBtn) newChatBtn.addEventListener('click', createNewConversation);

const newChatCollapsedBtn = document.getElementById('new-chat-collapsed');
if (newChatCollapsedBtn) newChatCollapsedBtn.addEventListener('click', createNewConversation);

document.addEventListener('keydown', (e) => {
    const chatPage = document.getElementById('chat-page');
    const inChat = chatPage && !chatPage.classList.contains('hidden');
    if (!inChat) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNewConversation();
    }
});

// ===== MARKDOWN =====
function markdownToHTML(text) {
    const codeBlocks = [];
    const tableBlocks = [];

    const renderInlineMarkdown = (value) => String(value ?? '')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    text = String(text || '').replace(/```([^\n`]*)\n?([\s\S]+?)```/g, (_, rawLang, code) => {
        const token = `@@NEXUS_CODE_${codeBlocks.length}@@`;
        const lang = String(rawLang || '').trim().toLowerCase().replace(/[^a-z0-9_+#.-]/g, '');
        const label = lang || 'text';
        const langAttr = lang ? ` class="language-${lang}"` : '';
        const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        codeBlocks.push(`<section class="code-block-wrapper"><div class="code-block-toolbar"><span class="code-language">${label}</span><button class="copy-code-btn" type="button" onclick="copyCode(this)" aria-label="Copier le code"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copier</span></button></div><pre><code${langAttr}>${escaped}</code></pre></section>`);
        return token;
    });

    // Robust line-by-line Markdown table detection.
    const lines = text.split('\n');
    const out = [];
    const splitRow = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const isSeparatorRow = line => {
        const cells = splitRow(line);
        return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
    };

    for (let i = 0; i < lines.length; i++) {
        const headerLine = lines[i];
        const separatorLine = lines[i + 1];

        if (headerLine?.includes('|') && separatorLine?.includes('|') && isSeparatorRow(separatorLine)) {
            const headers = splitRow(headerLine);
            const rows = [];
            i += 2;

            while (i < lines.length) {
                const candidate = lines[i].trim();
                if (!candidate) {
                    if (lines[i + 1]?.includes('|')) { i++; continue; }
                    break;
                }
                if (!candidate.includes('|') || /^---+$/.test(candidate)) break;
                const row = splitRow(candidate);
                if (row.length < 2) break;
                rows.push(row);
                i++;
            }
            i--;

            if (headers.length >= 2 && rows.length) {
                const head = '<thead><tr>' + headers.map(cell => '<th>' + renderInlineMarkdown(cell) + '</th>').join('') + '</tr></thead>';
                const body = '<tbody>' + rows.map(row =>
                    '<tr>' + headers.map((_, col) => '<td>' + renderInlineMarkdown(row[col] || '') + '</td>').join('') + '</tr>'
                ).join('') + '</tbody>';
                const token = `@@NEXUS_TABLE_${tableBlocks.length}@@`;
                tableBlocks.push('<div class="md-table-wrap"><table class="md-table">' + head + body + '</table></div>');
                out.push(token);
                continue;
            }
        }

        out.push(headerLine);
    }
    text = out.join('\n');

    // Block separators.
    text = text.replace(/^\s*---+\s*$/gm, '<hr>');

    // Headings, including #### / ##### / ######.
    text = text.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    text = text.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Inline Markdown outside tables.
    text = renderInlineMarkdown(text);
    text = text.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    // Ordered and unordered lists.
    text = text.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
    text = text.replace(/(?:^|\n)((?:<li>[\s\S]*?<\/li>\s*)+)/g, (_, items) => '\n<ul>' + items + '</ul>');
    text = text.replace(/^\s*\d+[.)]\s+(.+)$/gm, '<oli>$1</oli>');
    text = text.replace(/(?:^|\n)((?:<oli>[\s\S]*?<\/oli>\s*)+)/g, (_, items) =>
        '\n<ol>' + items.replace(/<\/?oli>/g, m => m.startsWith('</') ? '</li>' : '<li>') + '</ol>'
    );

    // Paragraphs / line breaks while preserving structural placeholders.
    const blocks = text.split(/\n{2,}/).map(chunk => chunk.trim()).filter(Boolean);
    text = blocks.map(chunk => {
        if (/^(<h[1-6]|<ul>|<ol>|<blockquote>|<hr>|@@NEXUS_TABLE_|@@NEXUS_CODE_)/.test(chunk)) {
            return chunk.replace(/\n/g, '');
        }
        return '<p>' + chunk.replace(/\n/g, '<br>') + '</p>';
    }).join('');

    tableBlocks.forEach((html, i) => {
        text = text.replace(`@@NEXUS_TABLE_${i}@@`, html);
    });
    codeBlocks.forEach((html, i) => {
        text = text.replace(`@@NEXUS_CODE_${i}@@`, html);
    });

    return text;
}
// ===== TYPEWRITER =====
let stopRequested = false;
let currentFetch = null;

window.stopGeneration = function() {
    stopRequested = true;
    if (currentFetch) { currentFetch.abort(); currentFetch = null; }
    isTyping = false;
    hideTypingIndicator();
    sendButton.disabled = false;
    userInput.disabled  = false;
    userInput.focus();
    toggleStopButton(false);
};

function toggleStopButton(show) {
    const stopBtn = document.getElementById('stop-button');
    if (!stopBtn) return;
    stopBtn.classList.toggle('hidden', !show);
    sendButton.classList.toggle('hidden', show);
}

async function typeWriter(element, text, isHTML) {
    element.classList.add('typing');
    isTyping = true;
    stopRequested = false;
    const speed = window._typingSpeed ?? TYPING_SPEED;

    if (isHTML) {
        const html = markdownToHTML(text);
        if (speed === 0) {
            element.innerHTML = html;
        } else {
            const temp = document.createElement('div');
            temp.innerHTML = html;
            const plain = temp.textContent;
            const tokens = plain.match(/\S+|\s+/g) || [];
            let buf = '';
            for (const token of tokens) {
                if (stopRequested) break;
                buf += token;
                if (token.trim()) {
                    element.innerHTML = markdownToHTML(buf);
                    chatBox.scrollTop = chatBox.scrollHeight;
                    await new Promise(r => setTimeout(r, speed));
                }
            }
            element.innerHTML = html;
        }
    } else {
        if (speed === 0) {
            element.textContent = text;
        } else {
            const tokens = text.match(/\S+|\s+/g) || [];
            let buf = '';
            for (const token of tokens) {
                if (stopRequested) break;
                buf += token;
                if (token.trim()) {
                    element.textContent = buf;
                    chatBox.scrollTop = chatBox.scrollHeight;
                    await new Promise(r => setTimeout(r, speed));
                }
            }
            element.textContent = text;
        }
    }

    element.classList.remove('typing');
    isTyping = false;

    if (isHTML && typeof hljs !== 'undefined') {
        element.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
    }
}

// ===== MESSAGES =====
async function addMessage(className, message, isHTML = false, animate = true) {
    removeEmptyState();
    const msg = document.createElement('div');
    msg.className = className;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.title = 'Copier';
    copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.onclick = () => {
        navigator.clipboard.writeText(message).then(() => {
            copyBtn.classList.add('copied');
            copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(() => {
                copyBtn.classList.remove('copied');
                copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            }, 1800);
        }).catch(() => {});
    };
    msg.appendChild(copyBtn);
    chatBox.appendChild(msg);
    chatBox.scrollTop = chatBox.scrollHeight;

    if (className === 'bot-message' && animate) {
        await typeWriter(msg, message, isHTML);
    } else {
        if (isHTML) msg.innerHTML = markdownToHTML(message);
        else msg.textContent = message;
    }

    const conv = getCurrentConversation();
    if (conv && !conv.messages.find(m => m.content === message)) {
        conv.messages.push({ type: className.includes('user') ? 'user' : 'bot', content: message });
        debouncedSave(conv);
    }

    if (className === 'bot-message') {
        const project = extractGeneratedProject(message);
        if (project.files.length) setGeneratedProject(project);
    }

    return msg;
}

// ===== CODE ARTEFACTS + ISOLATED STATIC PREVIEW =====
let generatedProject = { files: [] };
const svgIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l4 4v16H6zM14 2v5h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';

function extractGeneratedProject(text) {
    const hit = String(text || '').match(/```nexus-files\s*([\s\S]*?)```/i);
    if (!hit) return { files: [] };
    try {
        const data = JSON.parse(hit[1].trim());
        const files = (data.files || []).filter(f => f && typeof f.path === 'string' && typeof f.content === 'string' && isSafeProjectPath(f.path) && f.content.length <= 1024 * 1024)
            .map(f => ({ path: f.path.replace(/\\/g, '/'), content: f.content, language: String(f.language || '').slice(0, 30) }));
        return { files: files.slice(0, 50) };
    } catch { return { files: [] }; }
}
function isSafeProjectPath(path) { return !!path && path.length <= 240 && !path.includes('..') && !path.startsWith('/') && !/[\x00-\x1f]/.test(path); }
function fileSizeText(content) { const n = new Blob([content]).size; return n < 1024 ? `${n} o` : `${(n / 1024).toFixed(1)} Ko`; }
function downloadBlob(name, blob) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

function setGeneratedProject(project) {
    generatedProject = project;
    const list = document.getElementById('generated-files');
    const count = document.getElementById('code-file-count');
    if (!list || !count) return;
    list.replaceChildren();
    count.textContent = `${project.files.length} fichier${project.files.length > 1 ? 's' : ''}`;
    for (const file of project.files) {
        const card = document.createElement('article'); card.className = 'generated-file-card';
        const meta = document.createElement('div'); meta.className = 'generated-file-meta';
        meta.innerHTML = `${svgIcon}<div><strong></strong><span></span></div>`;
        meta.querySelector('strong').textContent = file.path;
        meta.querySelector('span').textContent = `${file.language || file.path.split('.').pop() || 'texte'} · ${fileSizeText(file.content)}`;
        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Télécharger'; button.onclick = () => downloadBlob(file.path.split('/').pop(), new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
        card.append(meta, button); list.appendChild(card);
    }
    document.getElementById('download-all-btn').disabled = !project.files.length;
    document.getElementById('preview-btn').disabled = !project.files.some(f => f.path.toLowerCase() === 'index.html');
    document.getElementById('github-push-btn').disabled = !project.files.length;
}

function previewDocument() {
    const html = generatedProject.files.find(f => /(^|\/)index\.html$/i.test(f.path));
    if (!html) return '';
    const byName = name => generatedProject.files.find(f => f.path === name || f.path.endsWith('/' + name));
    let source = html.content;
    source = source.replace(/<link([^>]*?)href=["']([^"']+)["']([^>]*)>/gi, (all, before, href, after) => {
        const f = byName(href); return f && /\.css(?:$|\?)/i.test(href) ? `<style>\n${f.content}\n</style>` : all;
    });
    source = source.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/gi, (all, before, src, after) => {
        const f = byName(src); return f && /\.js(?:$|\?)/i.test(src) ? `<script${before}${after}>\n${f.content}\n<\/script>` : all;
    });
    const bridge = `<script>['error','unhandledrejection'].forEach(t=>addEventListener(t,e=>parent.postMessage({source:'nexus-preview',type:t,message:String(e.message||e.reason||'Erreur')},'*'))); const c=console.error; console.error=(...a)=>{parent.postMessage({source:'nexus-preview',type:'console',message:a.map(String).join(' ')},'*');c(...a)};<\/script>`;
    return source.replace(/<head([^>]*)>/i, `<head$1>${bridge}`) || bridge + source;
}
function renderPreview() {
    const frame = document.getElementById('project-preview'), panel = document.getElementById('preview-panel'), errors = document.getElementById('preview-errors');
    if (!frame || !panel) return;
    panel.classList.remove('hidden'); errors?.classList.add('hidden'); if (errors) errors.textContent = '';
    frame.srcdoc = previewDocument();
}
function crc32(bytes) { let c = ~0; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function u16(n) { return [n & 255, (n >>> 8) & 255]; } function u32(n) { return [...u16(n), ...u16(n >>> 16)]; }
function makeZip(files) { const enc = new TextEncoder(), chunks = [], entries = []; let offset = 0;
    for (const f of files) { const name = enc.encode(f.path), data = enc.encode(f.content), crc = crc32(data); const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...name, ...data]); chunks.push(local); entries.push({ name, data, crc, offset }); offset += local.length; }
    const centralStart = offset; for (const e of entries) { const c = new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(e.crc), ...u32(e.data.length), ...u32(e.data.length), ...u16(e.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(e.offset), ...e.name]); chunks.push(c); offset += c.length; }
    chunks.push(new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(offset - centralStart), ...u32(centralStart), ...u16(0)])); return new Blob(chunks, { type: 'application/zip' }); }

window.addEventListener('message', event => { if (event.data?.source !== 'nexus-preview') return; const errors = document.getElementById('preview-errors'); if (!errors) return; errors.classList.remove('hidden'); errors.textContent += `[${event.data.type}] ${event.data.message}\n`; });

function githubSession() {
    return sessionStorage.getItem('nexus_github_session') || '';
}
function githubAuthHeaders() {
    const headers = authHeaders();
    const session = githubSession();
    if (session) headers['X-GitHub-Session'] = session;
    return headers;
}
function selectedGithubRepo() {
    return localStorage.getItem('nexus_github_repo') || '';
}
function selectedGithubBranch() {
    return localStorage.getItem('nexus_github_branch') || '';
}
function setSelectedGithubRepo(repo, branch) {
    if (repo) localStorage.setItem('nexus_github_repo', repo);
    else localStorage.removeItem('nexus_github_repo');
    if (branch) localStorage.setItem('nexus_github_branch', branch);
    else localStorage.removeItem('nexus_github_branch');
    updateGithubSelectionUI();
}
function updateGithubSelectionUI() {
    const readBtn = document.getElementById('github-read-btn');
    const chip = document.getElementById('active-github-repo');
    const chipName = document.getElementById('active-github-repo-name');
    const repo = selectedGithubRepo();
    const branch = selectedGithubBranch();

    if (readBtn) {
        const label = readBtn.querySelector('span');
        if (label) label.textContent = repo ? `Dépôt : ${repo.split('/').pop()}` : 'Sélectionner un dépôt';
        readBtn.title = repo ? `${repo} · ${branch || 'branche par défaut'}` : 'Sélectionner un dépôt GitHub';
    }

    if (chip && chipName) {
        chip.classList.toggle('hidden', !repo);
        chipName.textContent = repo ? repo.split('/').pop() : '';
        chip.title = repo ? `${repo} · ${branch || 'branche par défaut'}` : '';
    }
}
function consumeGithubOAuthReturn() {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const session = hash.get('github_session');
    const failed = hash.get('github') === 'failed';

    if (session) {
        sessionStorage.setItem('nexus_github_session', session);
        history.replaceState(null, '', window.location.pathname + window.location.search);
        setTimeout(() => {
            refreshGithubStatus();
            showToast('GitHub connecté.', '', 2500);
        }, 0);
    } else if (failed) {
        sessionStorage.removeItem('nexus_github_return_state');
        history.replaceState(null, '', window.location.pathname + window.location.search);
        setTimeout(() => showToast('Connexion GitHub échouée.', 'error', 3500), 0);
    }
}
function setGithubConnectLabel(connected) {
    const button = document.getElementById('github-connect-btn');
    if (!button) return;
    button.dataset.connected = connected ? 'true' : 'false';
    const label = button.querySelector('span');
    if (label) label.textContent = connected ? 'Déconnecter' : 'Connecter GitHub';
}
async function refreshGithubStatus() {
    const status = document.getElementById('github-status');
    if (!status || !getToken()) return;
    try {
        const r = await fetch(`${API_BASE}/github/status`, { headers: githubAuthHeaders(), credentials: 'include' });
        const d = await r.json();
        const connected = !!d.connected;
        status.textContent = connected ? `Connecté : ${d.login}` : 'Non connecté';
        setGithubConnectLabel(connected);
        const readBtn = document.getElementById('github-read-btn');
        if (readBtn) readBtn.disabled = !connected;
        if (!connected) setSelectedGithubRepo('', '');
        updateGithubSelectionUI();
    } catch {
        status.textContent = 'Indisponible';
        setGithubConnectLabel(false);
    }
}
async function connectGithub() {
    const button = document.getElementById('github-connect-btn');
    if (button?.dataset.connected === 'true') {
        sessionStorage.removeItem('nexus_github_session');
        sessionStorage.removeItem('nexus_github_return_state');
        setSelectedGithubRepo('', '');
        await fetch(`${API_BASE}/github/disconnect`, { method: 'POST', headers: authHeaders(), credentials: 'include' });
        return refreshGithubStatus();
    }

    await ensureCurrentConversationPersisted();
    const conv = getCurrentConversation();
    sessionStorage.setItem('nexus_github_return_state', JSON.stringify({
        conversationId: currentConversationId,
        assistantMode: conv?.assistantMode || 'chat',
        codeTask: conv?.codeTask || 'build',
        chatScrollTop: chatBox?.scrollTop || 0,
    }));

    const r = await fetch(`${API_BASE}/github/connect`, { headers: authHeaders(), credentials: 'include' });
    const d = await r.json();
    if (!r.ok) return showToast(d.error || 'Connexion GitHub indisponible.', 'error');
    window.location.assign(d.url);
}
async function pushGeneratedProject() {
    if (!generatedProject.files.length) return;
    const repo = selectedGithubRepo();
    let branch = selectedGithubBranch();
    if (!repo) {
        showToast('Sélectionne d’abord un dépôt GitHub.', 'error', 3500);
        return readGithubRepository();
    }

    const [owner, name] = repo.split('/');
    if (!branch) {
        const branchesResponse = await fetch(`${API_BASE}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`, { headers: githubAuthHeaders(), credentials: 'include' });
        const branches = await branchesResponse.json();
        if (!branchesResponse.ok || !branches.length) return showToast(branches.error || 'Branches indisponibles.', 'error');
        branch = branches[0].name;
        localStorage.setItem('nexus_github_branch', branch);
    }

    const message = prompt('Message de commit :', 'Update from Nexus AI');
    if (!message) return;
    if (!confirm(`Créer ou mettre à jour ${generatedProject.files.length} fichier(s) sur ${repo}/${branch} ?`)) return;

    const r = await fetch(`${API_BASE}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commit`, {
        method: 'POST',
        headers: githubAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify({ branch, message, files: generatedProject.files, confirm: true })
    });
    const d = await r.json();
    showToast(r.ok ? `Commit créé : ${d.results.length} fichier(s) sur ${repo}.` : (d.error || 'Commit impossible.'), r.ok ? '' : 'error', 4000);
}
function escapeGithubHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
}
function closeGithubRepoBrowser() {
    document.getElementById('github-repo-overlay')?.remove();
}
async function readGithubRepository() {
    closeComposerPlusMenu();
    document.getElementById('github-repo-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'github-repo-overlay';
    overlay.className = 'github-repo-overlay';
    overlay.innerHTML = `
        <div class="github-repo-modal" role="dialog" aria-modal="true" aria-label="Sélectionner un dépôt GitHub">
            <div class="github-repo-header">
                <div><strong>Sélectionner un dépôt</strong><span>Nexus AI travaillera directement dans ce dépôt.</span></div>
                <button type="button" class="github-repo-close" aria-label="Fermer">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="github-repo-toolbar">
                <input id="github-repo-search" type="search" placeholder="Rechercher un dépôt…" autocomplete="off">
            </div>
            <div id="github-repo-content" class="github-repo-content"><div class="github-browser-loading">Chargement des dépôts…</div></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.github-repo-close').onclick = closeGithubRepoBrowser;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeGithubRepoBrowser(); });

    const content = overlay.querySelector('#github-repo-content');
    try {
        const response = await fetch(`${API_BASE}/github/repos`, { headers: githubAuthHeaders(), credentials: 'include' });
        const repos = await response.json();
        if (!response.ok) throw new Error(repos.error || 'Impossible de charger les dépôts.');
        renderGithubRepoList(repos);
    } catch (error) {
        content.innerHTML = `<div class="github-browser-empty">${escapeGithubHTML(error.message)}</div>`;
    }
}
function renderGithubRepoList(repos) {
    const content = document.getElementById('github-repo-content');
    const search = document.getElementById('github-repo-search');
    if (!content) return;

    const current = selectedGithubRepo();
    const render = (query = '') => {
        const q = query.trim().toLowerCase();
        const filtered = repos.filter(repo => !q || repo.fullName.toLowerCase().includes(q));
        if (!filtered.length) {
            content.innerHTML = '<div class="github-browser-empty">Aucun dépôt trouvé.</div>';
            return;
        }
        content.innerHTML = filtered.map(repo => `
            <button type="button" class="github-repo-card ${repo.fullName === current ? 'selected' : ''}" data-repo="${escapeGithubHTML(repo.fullName)}" data-default-branch="${escapeGithubHTML(repo.defaultBranch || 'main')}">
                <span class="github-repo-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/></svg></span>
                <span class="github-repo-card-copy"><strong>${escapeGithubHTML(repo.fullName)}</strong><small>${repo.private ? 'Privé' : 'Public'} · branche ${escapeGithubHTML(repo.defaultBranch || 'main')}</small></span>
                <svg class="github-repo-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
            </button>
        `).join('');
        content.querySelectorAll('.github-repo-card').forEach(button => {
            button.onclick = () => selectGithubRepository(button.dataset.repo, button.dataset.defaultBranch);
        });
    };
    render();
    if (search) search.oninput = () => render(search.value);
}
function selectGithubRepository(repo, branch = 'main') {
    setSelectedGithubRepo(repo, branch);
    closeGithubRepoBrowser();
    showToast(`Dépôt actif : ${repo} · ${branch}`, '', 3000);
}
async function buildGithubRepoContext(message) {
    const repo = selectedGithubRepo();
    const branch = selectedGithubBranch();
    const conv = getCurrentConversation();
    if (!repo || !branch || conv?.assistantMode !== 'code') return '';

    const [owner, name] = repo.split('/');
    try {
        const treeResponse = await fetch(`${API_BASE}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tree?ref=${encodeURIComponent(branch)}`, { headers: githubAuthHeaders(), credentials: 'include' });
        const treeData = await treeResponse.json();
        if (!treeResponse.ok) return '';

        const files = (treeData.files || []).filter(f => {
            const p = String(f.path || '').toLowerCase();
            return !/(^|\/)(node_modules|dist|build|vendor|\.git)\//.test(p)
                && /\.(js|mjs|cjs|ts|tsx|jsx|html|css|scss|json|md|py|php|java|yml|yaml|toml|env\.example)$/i.test(p);
        });

        const words = String(message || '').toLowerCase().match(/[a-z0-9_.-]{4,}/g) || [];
        const scored = files.map(file => {
            const path = file.path.toLowerCase();
            let score = 0;
            for (const word of words) if (path.includes(word)) score += 5;
            if (/(^|\/)(readme\.md|package\.json|vite\.config\.[jt]s|server\.[jt]s|app\.[jt]s|index\.html)$/i.test(file.path)) score += 3;
            if (file.size && file.size < 80000) score += 1;
            return { ...file, score };
        }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

        const chosen = scored.slice(0, 8);
        const parts = [];
        let total = 0;
        for (const file of chosen) {
            if (total > 55000) break;
            const r = await fetch(`${API_BASE}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/file?path=${encodeURIComponent(file.path)}&ref=${encodeURIComponent(branch)}`, { headers: githubAuthHeaders(), credentials: 'include' });
            const data = await r.json();
            if (!r.ok || typeof data.content !== 'string') continue;
            const remaining = Math.max(0, 55000 - total);
            const text = data.content.slice(0, remaining);
            total += text.length;
            parts.push(`--- ${file.path} ---\n${text}`);
        }

        const treePreview = files.slice(0, 300).map(f => f.path).join('\n');
        return `[Dépôt GitHub actif]\nDépôt : ${repo}\nBranche : ${branch}\n\nArborescence :\n${treePreview}\n\nFichiers chargés automatiquement :\n${parts.join('\n\n')}`;
    } catch {
        return '';
    }
}

function setFooterGenerating(generating) {
    const footer = document.querySelector('.footer');
    if (footer) footer.classList.toggle('generation-active', !!generating);
}

function showTypingIndicator() {
    setFooterGenerating(true);
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.id = 'typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    chatBox.appendChild(el);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function hideTypingIndicator() {
    const el = document.getElementById('typing');
    if (el) el.remove();
    setFooterGenerating(false);
}

// ===== TICKET =====
function formatDate(d) { return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getFullYear()).slice(-2)}`; }
function formatTime(d) { return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function generateRandomSequence() { return Array.from({length:6}, () => String(Math.floor(Math.random()*100)).padStart(2,'0')).join("'"); }
function generateRandomLetter() { return String.fromCharCode(65 + Math.floor(Math.random()*26)); }
function generateRandomCode() {
    const l1 = generateRandomLetter();
    let l2, l3;
    do { l2 = generateRandomLetter(); } while (l2 === l1);
    do { l3 = generateRandomLetter(); } while (l3 === l1 || l3 === l2);
    return `${l1}${Math.floor(Math.random()*10)}${l2}${l3}`;
}

// ===== SYSTEM PROMPT BUILDER =====
function buildSystemPrompt() {
    const s = loadSettings();
    let prompt = "Tu es Nexus AI, un assistant IA intelligent, sympa et utile cree par l'entreprise Nexus. Tu reponds en francais.";
    if (s.alias) prompt += ` L'utilisateur s'appelle ${s.alias}.`;
    if (s.profession) prompt += ` Sa profession est : ${s.profession}.`;
    if (s.about) prompt += ` Informations sur l'utilisateur : ${s.about}.`;
    const styleMap = { formal: 'Adopte un style formel et professionnel.', casual: 'Adopte un style decontracte et familier.', concise: 'Sois tres concis et va droit au but.', detailed: 'Donne des reponses detaillees et completes.' };
    if (styleMap[s.style]) prompt += ' ' + styleMap[s.style];
    if (s.warm === 'more') prompt += ' Sois tres chaleureux et bienveillant.';
    if (s.warm === 'less') prompt += ' Reste neutre et factuel.';
    if (s.enthusiastic === 'more') prompt += " Montre de l'enthousiasme dans tes reponses.";
    if (s.enthusiastic === 'less') prompt += ' Garde un ton calme et pose.';
    if (s.lists === 'more') prompt += ' Utilise souvent des titres et des listes.';
    if (s.lists === 'less') prompt += ' Evite les listes et les titres, prefere la prose.';
    if (s.emojis === 'more') prompt += ' Utilise des emojis pour illustrer tes reponses.';
    if (s.emojis === 'less') prompt += " N'utilise pas d'emojis.";
    if (s.contentFilter || s.safeMode) prompt += ' Filtre tout contenu inapproprie.';
    if (s.instructions) prompt += '\n\nInstructions personnalisees : ' + s.instructions;
    if (s.webSearch) prompt += '\n\nDes résultats de recherche web peuvent être fournis avant ta question. Utilise-les pour donner des réponses précises et à jour. Cite toujours les sources avec leur URL.';
    prompt += "\n\nIMPORTANT: Tu PEUX analyser tous les fichiers. Tu peux utiliser le formatage Markdown.";
    const conv = getCurrentConversation();
    if (conv?.assistantMode === 'code') {
        const task = conv.codeTask || 'build';
        prompt += `\n\nMode Code actif (${task}). Réponds comme un ingénieur logiciel : privilégie du code exécutable, des changements minimaux et compatibles avec l'architecture fournie. Pour plusieurs fichiers, retourne aussi un bloc nexus-files avec les fichiers complets modifiés afin qu'ils puissent être commités. Vérifie les imports, contrats d'API, variables d'environnement, erreurs de syntaxe et effets de bord avant de conclure.`;
        const repo = selectedGithubRepo();
        const branch = selectedGithubBranch();
        if (repo) prompt += `\nDépôt GitHub actif : ${repo} · branche ${branch || 'par défaut'}. Travaille en priorité dans ce dépôt et conserve ses conventions existantes.`;
    }
    prompt += buildMemoryContext();
    return prompt;
}

// ===== RECHERCHE WEB =====
async function webSearch(query) {
    const s = loadSettings();
    const provider = s.webSearchProvider || 'tavily';
    const key = s.webSearchKey || (provider === 'tavily' ? TAVILY_KEY : '');
    const maxResults = parseInt(s.webSearchMaxResults) || 5;

    if (!key) throw new Error('Clé API manquante — configurez-la dans Paramètres › Applications');

    if (provider === 'tavily') {
        const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: key, query, max_results: maxResults, search_depth: 'basic', include_answer: false })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Tavily erreur ${res.status}`);
        }
        const data = await res.json();
        return (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }));
    }

    if (provider === 'brave') {
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
            headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }
        });
        if (!res.ok) throw new Error(`Brave erreur ${res.status}`);
        const data = await res.json();
        return (data.web?.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.description }));
    }

    throw new Error('Fournisseur inconnu');
}

function shouldSearchWeb(message) {
    const s = loadSettings();
    const key = s.webSearchKey || TAVILY_KEY;
    if (!s.webSearch || !key) return false;
    if (s.webSearchMode === 'always') return true;
    if (s.webSearchMode === 'never') return false;
    const lower = message.toLowerCase();
    return lower.includes('?') ||
        /\b(qui est|qu.est|c.est quoi|comment|pourquoi|quand|o[uù]|quelle? est|actualit|r[eé]cent|aujourd|maintenant|m[eé]t[eé]o|prix|cours|vrai(ment)?|v[eé]rifi|source|prouve|confirme|cherche|recherche|trouve|d[eé]finit|explique)\b/.test(lower);
}

function formatSearchResults(results) {
    if (!results || !results.length) return null;
    let ctx = '[Résultats de recherche web — informations actuelles]\n\n';
    results.forEach((r, i) => {
        ctx += `Source ${i + 1} : ${r.title}\nURL : ${r.url}\n${r.snippet || ''}\n\n`;
    });
    ctx += 'Utilise ces sources pour répondre précisément. Cite les URLs pertinentes dans ta réponse.';
    return ctx;
}

function showSearchIndicator() {
    const el = document.createElement('div');
    el.id = 'search-indicator';
    el.className = 'search-indicator';
    el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><span>Recherche web en cours…</span>';
    chatBox.appendChild(el);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function hideSearchIndicator() {
    const el = document.getElementById('search-indicator');
    if (el) el.remove();
}

function showWebSources(sources) {
    if (!sources || !sources.length) return;
    const el = document.createElement('div');
    el.className = 'web-sources';
    const items = sources.map(s => {
        let hostname = '';
        try { hostname = new URL(s.url).hostname; } catch {}
        return `<a href="${s.url}" target="_blank" rel="noopener" class="source-item" title="${(s.snippet || '').replace(/"/g, '')}">
            <img class="source-favicon" src="https://www.google.com/s2/favicons?domain=${hostname}&sz=16" onerror="this.style.display='none'" width="14" height="14">
            <span class="source-title">${s.title}</span>
        </a>`;
    }).join('');
    el.innerHTML = `
        <div class="sources-header">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            Sources web
        </div>
        <div class="sources-list">${items}</div>`;
    chatBox.appendChild(el);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// ===== API GROQ =====
async function getGroqAIResponse(message, searchContext = null) {
    try {
        const conv = getCurrentConversation();
        if (!conv.history) conv.history = [];

        // Tous les fichiers envoient leur contenu texte (images: description BLIP)
        let fullMessage = message || '';

        if (searchContext) {
            fullMessage = searchContext + '\n\n---\n\nQuestion : ' + fullMessage;
        }

        const githubContext = await buildGithubRepoContext(message);
        if (githubContext) {
            fullMessage = githubContext + '\n\n---\n\nDemande utilisateur : ' + fullMessage;
        }

        if (attachedFiles.length > 0) {
            attachedFiles.forEach(f => {
                fullMessage += `\n\n[Fichier joint : ${f.name} (${formatFileSize(f.size)})]\n`;
                if (f.content && f.kind !== 'binary') {
                    const preview = f.content.length > 15000
                        ? f.content.substring(0, 15000) + `\n[... ${f.content.length - 15000} caracteres tronques]`
                        : f.content;
                    fullMessage += preview + '\n';
                } else {
                    fullMessage += `Type : ${f.type} - non analysable\n`;
                }
            });
        }

        conv.history.push({ role: 'user', content: fullMessage || 'Analyse ces fichiers' });

        currentFetch = new AbortController();
        const _t0 = performance.now();
        const response = await fetch(`${API_BASE}/chat`, {
            method: 'POST',
            headers: authHeaders(),
            signal: currentFetch.signal,
            body: JSON.stringify({
                model: currentModel,
                mode: { assistantMode: conv.assistantMode || 'chat', codeTask: conv.codeTask || 'build' },
                messages: [
                    { role: 'system', content: buildSystemPrompt() },
                    ...conv.history
                ]
            })
        });

        currentFetch = null;
        if (!response.ok) {
            if (response.status === 401) { handleLogout(); return ''; }
            let msg = 'Erreur de connexion à Nexus AI. Réessaie dans quelques secondes.';
            try { const e = await response.json(); if (e && e.error) msg = e.error; } catch {}
            return msg;
        }

        const data = await response.json();
        const aiResponse = data.choices[0].message.content;

        // Compteur de vitesse fantôme (moat Groq)
        updateSpeedMeter(data, aiResponse, (performance.now() - _t0) / 1000);

        conv.history.push({ role: 'assistant', content: aiResponse });
        if (conv.history.length > 20) conv.history = conv.history.slice(-20);

        saveConversationToServer(conv);
        attachedFiles = [];
        renderUploadedFiles();

        // Extraction mémoire en arrière-plan (silencieux)
        const s = loadSettings();
        if (s.memory !== false) {
            extractAndSaveMemory(message || '', aiResponse).catch(() => {});
        }

        return aiResponse;
    } catch (error) {
        if (error.name === 'AbortError') return '';
        console.error('Erreur:', error);
        return 'Erreur de connexion. Verifie ta connexion internet.';
    }
}

// ===== GESTION MESSAGES =====
async function handleMessage() {
    const message = userInput.value.trim();
    if (!message && attachedFiles.length === 0) return;
    if (isTyping) return;

    sendButton.disabled = true;
    userInput.disabled  = true;

    const persistedConv = await ensureCurrentConversationPersisted();
    if (!persistedConv) {
        sendButton.disabled = false;
        userInput.disabled = false;
        userInput.focus();
        return;
    }

    const displayMessage = message || '[Fichier(s) envoye(s)]';
    await addMessage('user-message', displayMessage, false, false);
    updateConversationTitle(displayMessage);

    // Persist the first user message immediately before the AI call.
    await saveConversationToServer(getCurrentConversation());

    userInput.value = '';
    userInput.style.height = 'auto';

    if (message === '1h' && attachedFiles.length === 0) {
        const now = new Date();
        const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
        // Numéro de l'utilisateur connecté (chiffres uniquement), sinon numéro par défaut
        const ticketPhone = ((getUser() || {}).phone || '').replace(/\D/g, '') || '0783643942';
        const ticket = `Titre 1 voyage\n\nA présenter au conducteur à la montée\nLe ${formatDate(now)}\nDe ${formatTime(now)} a ${formatTime(oneHourLater)}\n\n1.35 E\n\n${generateRandomSequence()}\n\n${ticketPhone}${generateRandomCode()}\n\nCGV : www.tcat.fr/cgv-ticket-sms`;
        setTimeout(async () => {
            await addMessage('bot-message', ticket, false, true);
            sendButton.disabled = false;
            userInput.disabled  = false;
            userInput.focus();
            toggleStopButton(false);
        }, 500);
        navigator.clipboard.writeText(ticket).catch(console.error);
    } else {
        toggleStopButton(true);

        let searchContext = null;
        let searchSources = [];
        if (shouldSearchWeb(message)) {
            showSearchIndicator();
            try {
                const results = await webSearch(message);
                searchSources = results;
                searchContext = formatSearchResults(results);
            } catch (e) {
                showToast('Recherche web : ' + (e.message || 'Erreur'), 'error', 4000);
            }
            hideSearchIndicator();
        }

        showTypingIndicator();
        const aiResponse = await getGroqAIResponse(message || 'Analyse ces fichiers', searchContext);
        hideTypingIndicator();
        if (aiResponse) {
            await addMessage('bot-message', aiResponse, true, true);
            if (searchSources.length > 0) showWebSources(searchSources);
        }
        sendButton.disabled = false;
        userInput.disabled  = false;
        userInput.focus();
        toggleStopButton(false);
    }
}

if (sendButton) sendButton.addEventListener('click', handleMessage);

document.getElementById('download-all-btn')?.addEventListener('click', () => downloadBlob('nexus-project.zip', makeZip(generatedProject.files)));
document.getElementById('preview-btn')?.addEventListener('click', renderPreview);
document.getElementById('preview-reload-btn')?.addEventListener('click', renderPreview);
document.getElementById('preview-expand-btn')?.addEventListener('click', () => {
    const html = previewDocument(); if (!html) return; const url = URL.createObjectURL(new Blob([html], { type: 'text/html' })); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000);
});
document.getElementById('github-connect-btn')?.addEventListener('click', connectGithub);
document.getElementById('github-read-btn')?.addEventListener('click', readGithubRepository);
document.getElementById('active-github-repo')?.addEventListener('click', readGithubRepository);
document.getElementById('github-push-btn')?.addEventListener('click', pushGeneratedProject);

if (userInput) {
    userInput.addEventListener('input', () => {
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
    });
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            const s = loadSettings();
            if (s.enterSend !== false && !sendButton.disabled && !isTyping) {
                e.preventDefault();
                handleMessage();
            }
        }
    });
}

const loginPwd = document.getElementById('login-password');
const registerPwd = document.getElementById('register-password');
if (loginPwd) loginPwd.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleLogin(); });
if (registerPwd) registerPwd.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleRegister(); });

// ===== SETTINGS =====
const SETTINGS_KEY = 'nexus_settings';
let _settingsCache = null;
let _userMemory = [];

const defaultSettings = {
    theme: 'system', contrast: 'system', accent: '#00d2ff', langue: 'auto',
    typingSpeed: 15, flashMode: false, vocalMode: false, notifGroup: 'push', notifCodex: 'push',
    notifProjects: 'email', notifReco: 'both', notifReplies: 'push', notifTasks: 'both',
    notifUsage: 'both', style: 'default', warm: 'default', enthusiastic: 'default',
    lists: 'default', emojis: 'default', quickReplies: true, instructions: '',
    alias: '', profession: '', about: '', memory: false, modelImprove: true,
    twoFA: false, contentFilter: false, safeMode: false, enterSend: true,
    webSearch: true, webSearchProvider: 'tavily', webSearchKey: '', webSearchMaxResults: 5, webSearchMode: 'auto',
};

function loadSettings() {
    if (_settingsCache) return { ...defaultSettings, ..._settingsCache };
    try {
        return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
        return { ...defaultSettings };
    }
}

async function loadSettingsFromServer() {
    try {
        const res = await fetch(`${API_BASE}/user/settings`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        _settingsCache = data.settings || {};
        _userMemory = data.memory || [];

        if (data.user) {
            const localUser = getUser() || {};
            const canonicalUser = { ...localUser, ...data.user };
            localStorage.setItem('nexus_user', JSON.stringify(canonicalUser));
            const usernameEl = document.getElementById('sidebar-username');
            if (usernameEl && canonicalUser.username) usernameEl.textContent = `@${canonicalUser.username}`;
        }

        // /user/settings is the startup bootstrap source of truth. Restore
        // conversations from it so refresh/login cannot leave the sidebar empty.
        if (Array.isArray(data.conversations)) {
            const remote = normalizeConversationList(data.conversations);
            const localDraft = conversations.find(c => c._localDraft);
            conversations = localDraft ? [localDraft, ...remote] : remote;
            lastSyncFingerprint = conversationFingerprint(remote);
            renderConversationsList();

            const githubReturn = (() => {
                try { return JSON.parse(sessionStorage.getItem('nexus_github_return_state') || 'null'); }
                catch { return null; }
            })();
            const returnConversation = githubReturn?.conversationId
                ? remote.find(c => c._id === githubReturn.conversationId)
                : null;

            if (!localDraft && returnConversation) {
                await loadConversation(returnConversation._id);
                sessionStorage.removeItem('nexus_github_return_state');
            } else if (!localDraft && remote.length && !remote.some(c => c._id === currentConversationId)) {
                await loadConversation(remote[0]._id);
            } else if (!localDraft && !remote.length && !conversations.length) {
                createNewConversation();
            }
        }

        if (data.sidebarState === 'hidden') sidebar.classList.add('hidden');
        else if (window.innerWidth > 768) sidebar.classList.remove('hidden');
        const s = loadSettings();
        window._typingSpeed = s.flashMode ? 0 : s.typingSpeed;
        document.documentElement.style.setProperty('--accent', s.accent || '#00d2ff');
        if (s.theme === 'light') document.documentElement.classList.add('theme-light');
        else document.documentElement.classList.remove('theme-light');
        if (s.contrast === 'high') document.documentElement.classList.add('contrast-high');
        else document.documentElement.classList.remove('contrast-high');
        maybePromptPhone();
    } catch (err) {
        console.error('Erreur chargement settings:', err);
    }
}

async function saveSettingsToServer(s) {
    try {
        _settingsCache = s;
        await fetch(`${API_BASE}/user/settings`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ settings: s })
        });
    } catch (err) {
        console.error('Erreur sauvegarde settings:', err);
    }
}

async function saveSidebarStateToServer(state) {
    try {
        await fetch(`${API_BASE}/user/settings`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ sidebarState: state })
        });
    } catch (err) {
        console.error('Erreur sauvegarde sidebar:', err);
    }
}

// ===== MEMOIRE =====
async function saveMemoryToServer(memory) {
    try {
        _userMemory = memory;
        await fetch(`${API_BASE}/user/memory`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ memory })
        });
    } catch (err) { console.error('Erreur sauvegarde memoire:', err); }
}

async function extractAndSaveMemory(userMessage, aiResponse) {
    try {
        const res = await fetch(`${API_BASE}/chat`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                messages: [
                    {
                        role: 'system',
                        content: `Tu es un extracteur de memoire. Analyse la conversation et extrait UNIQUEMENT les informations personnelles importantes sur l'utilisateur a retenir pour les prochaines conversations (prenom, profession, preferences, projets, habitudes, etc).

Reponds UNIQUEMENT avec un JSON valide sous cette forme exacte :
{"facts": ["fait 1", "fait 2"]}

Si aucune info importante, reponds : {"facts": []}

Sois concis, max 10 mots par fait. Ne retiens que ce qui est vraiment utile pour personaliser les futures conversations.`
                    },
                    {
                        role: 'user',
                        content: `Message utilisateur: ${userMessage}\nReponse assistant: ${aiResponse}\n\nExtrait les faits importants sur l'utilisateur.`
                    }
                ]
            })
        });
        if (!res.ok) return;
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '{"facts":[]}';
        const clean = text.replace(/\`\`\`json|\`\`\`/g, '').trim();
        const parsed = JSON.parse(clean);
        const newFacts = parsed.facts || [];
        if (newFacts.length === 0) return;
        const updated = [..._userMemory, ...newFacts].slice(-50); // max 50 faits
        await saveMemoryToServer(updated);
    } catch (err) { /* silencieux */ }
}

function buildMemoryContext() {
    if (!_userMemory || _userMemory.length === 0) return '';
    return `\n\nMEMOIRE UTILISATEUR (infos retenues des conversations precedentes) :\n${_userMemory.map((f, i) => `- ${f}`).join('\n')}\nUtilise ces informations pour personaliser tes reponses.`;
}

window.getMemory = function() { return [..._userMemory]; };

window.deleteMemoryItem = async function(index) {
    try {
        await fetch(`${API_BASE}/user/memory/${index}`, { method: 'DELETE', headers: authHeaders() });
        _userMemory.splice(index, 1);
        renderMemoryList();
        showToast('Souvenir supprime.', 'success');
    } catch (err) { console.error(err); }
};

function escapeMemoryHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
}

function renderMemoryList() {
    const container = document.getElementById('memory-list');
    if (!container) return;
    if (_userMemory.length === 0) {
        container.innerHTML = '<div class="memory-empty"><strong>Aucun souvenir</strong><span>Nexus ajoutera ici les informations utiles retenues dans tes conversations.</span></div>';
        return;
    }
    const editIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
    const deleteIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
    container.innerHTML = _userMemory.map((fact, i) => '<div class="memory-item" data-memory-index="' + i + '"><div class="memory-item-content"><span class="memory-text">' + escapeMemoryHTML(fact) + '</span></div><div class="memory-item-actions"><button class="memory-edit" onclick="editMemoryItem(' + i + ')" title="Modifier" aria-label="Modifier">' + editIcon + '</button><button class="memory-delete" onclick="deleteMemoryItem(' + i + ')" title="Supprimer" aria-label="Supprimer">' + deleteIcon + '</button></div></div>').join('');
}

window.editMemoryItem = function(index) {
    const item = document.querySelector('[data-memory-index="' + index + '"]');
    if (!item || index < 0 || index >= _userMemory.length) return;
    item.querySelector('.memory-item-content').innerHTML = '<textarea class="memory-edit-input" rows="2">' + escapeMemoryHTML(_userMemory[index]) + '</textarea>';
    item.querySelector('.memory-item-actions').innerHTML = '<button class="memory-cancel" onclick="renderMemoryList()">Annuler</button><button class="memory-save" onclick="saveEditedMemoryItem(' + index + ')">OK</button>';
    const input = item.querySelector('.memory-edit-input');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
};

window.saveEditedMemoryItem = async function(index) {
    const item = document.querySelector('[data-memory-index="' + index + '"]');
    const value = (item?.querySelector('.memory-edit-input')?.value || '').trim();
    if (!value) { showToast('Le souvenir ne peut pas etre vide.', 'error'); return; }
    const previous = [..._userMemory];
    _userMemory[index] = value;
    try {
        await saveMemoryToServer(_userMemory);
        renderMemoryList();
        showToast('Souvenir modifie.', 'success');
    } catch (err) {
        _userMemory = previous;
        renderMemoryList();
        showToast('Impossible de modifier le souvenir.', 'error');
    }
};

window.openMemory = function() {
    const overlay = document.getElementById('memory-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    renderMemoryList();
};

window.closeMemory = function() {
    const overlay = document.getElementById('memory-overlay');
    if (overlay) overlay.classList.add('hidden');
};

window.clearAllMemory = async function() {
    if (!confirm('Effacer toute la memoire ? Cette action est irreversible.')) return;
    await saveMemoryToServer([]);
    renderMemoryList();
    showToast('Memoire effacee.', 'success');
};

function saveSettings() {
    const s = readSettingsFromDOM();
    _settingsCache = s;
    saveSettingsToServer(s);
}

function readSettingsFromDOM() {
    const g = id => document.getElementById(id);
    return {
        theme:         g('s-theme')?.value || defaultSettings.theme,
        contrast:      g('s-contrast')?.value || defaultSettings.contrast,
        accent:        g('s-accent')?.value || defaultSettings.accent,
        langue:        g('s-langue')?.value || defaultSettings.langue,
        typingSpeed:   parseInt(g('s-typing-speed')?.value ?? defaultSettings.typingSpeed),
        flashMode:     g('s-flash-mode')?.checked ?? defaultSettings.flashMode,
        vocalMode:     g('s-vocal-mode')?.checked ?? defaultSettings.vocalMode,
        notifGroup:    g('s-notif-group')?.value || defaultSettings.notifGroup,
        notifCodex:    g('s-notif-codex')?.value || defaultSettings.notifCodex,
        notifProjects: g('s-notif-projects')?.value || defaultSettings.notifProjects,
        notifReco:     g('s-notif-reco')?.value || defaultSettings.notifReco,
        notifReplies:  g('s-notif-replies')?.value || defaultSettings.notifReplies,
        notifTasks:    g('s-notif-tasks')?.value || defaultSettings.notifTasks,
        notifUsage:    g('s-notif-usage')?.value || defaultSettings.notifUsage,
        style:         g('s-style')?.value || defaultSettings.style,
        warm:          g('s-warm')?.value || defaultSettings.warm,
        enthusiastic:  g('s-enthusiastic')?.value || defaultSettings.enthusiastic,
        lists:         g('s-lists')?.value || defaultSettings.lists,
        emojis:        g('s-emojis')?.value || defaultSettings.emojis,
        quickReplies:  g('s-quick-replies')?.checked ?? defaultSettings.quickReplies,
        instructions:  g('s-instructions')?.value || '',
        alias:         g('s-alias')?.value || '',
        profession:    g('s-profession')?.value || '',
        about:         g('s-about')?.value || '',
        memory:        g('s-memory')?.checked ?? defaultSettings.memory,
        modelImprove:  g('s-model-improve')?.checked ?? defaultSettings.modelImprove,
        twoFA:         g('s-2fa')?.checked ?? defaultSettings.twoFA,
        contentFilter:       g('s-content-filter')?.checked ?? defaultSettings.contentFilter,
        safeMode:            g('s-safe-mode')?.checked ?? defaultSettings.safeMode,
        enterSend:           g('s-enter-send')?.checked ?? defaultSettings.enterSend,
        webSearch:           g('s-web-search')?.checked ?? defaultSettings.webSearch,
        webSearchProvider:   g('s-web-search-provider')?.value || defaultSettings.webSearchProvider,
        webSearchKey:        g('s-web-search-key')?.value || '',
        webSearchMaxResults: parseInt(g('s-web-search-max')?.value ?? defaultSettings.webSearchMaxResults),
        webSearchMode:       g('s-web-search-mode')?.value || defaultSettings.webSearchMode,
    };
}

function populateSettingsDOM(s) {
    const set   = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const check = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    set('s-theme', s.theme); set('s-contrast', s.contrast); set('s-accent', s.accent);
    set('s-langue', s.langue); set('s-typing-speed', s.typingSpeed);
    check('s-flash-mode', s.flashMode);
    check('s-vocal-mode', s.vocalMode);
    set('s-notif-group', s.notifGroup); set('s-notif-codex', s.notifCodex);
    set('s-notif-projects', s.notifProjects); set('s-notif-reco', s.notifReco);
    set('s-notif-replies', s.notifReplies); set('s-notif-tasks', s.notifTasks);
    set('s-notif-usage', s.notifUsage); set('s-style', s.style);
    set('s-warm', s.warm); set('s-enthusiastic', s.enthusiastic);
    set('s-lists', s.lists); set('s-emojis', s.emojis);
    check('s-quick-replies', s.quickReplies);
    set('s-instructions', s.instructions); set('s-alias', s.alias);
    set('s-profession', s.profession); set('s-about', s.about);
    check('s-memory', s.memory); check('s-model-improve', s.modelImprove);
    check('s-2fa', s.twoFA); check('s-content-filter', s.contentFilter);
    check('s-safe-mode', s.safeMode); check('s-enter-send', s.enterSend);
    check('s-web-search', s.webSearch);
    set('s-web-search-provider', s.webSearchProvider);
    set('s-web-search-key', s.webSearchKey);
    set('s-web-search-max', s.webSearchMaxResults);
    set('s-web-search-mode', s.webSearchMode);
    updateSliderLabel();
    updateColorDot();
}

function id(x) { return document.getElementById(x); }

function applySettings() {
    saveSettings();
    const s = loadSettings();
    window._typingSpeed = s.flashMode ? 0 : s.typingSpeed;
    document.documentElement.style.setProperty('--accent', s.accent);
    updateColorDot();
    const root = document.documentElement;
    if (s.theme === 'light') root.classList.add('theme-light');
    else root.classList.remove('theme-light');
    if (s.contrast === 'high') root.classList.add('contrast-high');
    else root.classList.remove('contrast-high');
}

function updateSliderLabel() {
    const slider = id('s-typing-speed');
    const label  = id('typing-speed-label');
    if (slider && label) label.textContent = slider.value + 'ms';
}

function updateColorDot() {
    const dot    = id('color-dot');
    const select = id('s-accent');
    if (dot && select) dot.style.background = select.value;
}

window.openSettings = function() {
    const overlay = id('settings-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    const s = loadSettings();
    populateSettingsDOM(s);
    applySettings();
    updateStorageInfo();
    const user = getUser();
    if (user) {
        const uEl = id('account-username');
        const eEl = id('account-email');
        if (uEl) uEl.textContent = '@' + user.username;
        if (eEl) eEl.textContent = user.email || '—';
        const pEl = id('s-phone');
        if (pEl) pEl.value = user.phone || '';
    }
};

window.closeSettings = function() {
    const overlay = id('settings-overlay');
    if (overlay) overlay.classList.add('hidden');
};

window.handleSettingsOverlayClick = function(e) {
    if (e.target === id('settings-overlay')) closeSettings();
};

window.switchSettingsTab = function(tab) {
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.settings-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === 'tab-' + tab);
    });
};

function updateStorageInfo() {
    try {
        const tokenSize = ((localStorage.getItem('nexus_token') || '').length + (localStorage.getItem('nexus_user') || '').length) * 2;
        const kb   = (tokenSize / 1024).toFixed(1);
        const used = id('storage-used');
        const fill = id('storage-bar-fill');
        if (used) used.textContent = kb + ' KB (donnees sur serveur)';
        if (fill) fill.style.width = '1%';
    } catch {}
}

window.exportData = function() {
    try {
        const data = {
            user: getUser(),
            settings: _settingsCache || loadSettings(),
            exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = 'nexus-data.json';
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (err) {
        alert("Erreur lors de l'export.");
    }
};

window.confirmDeleteAllConversations = function() {
    if (!confirm('Supprimer TOUTES vos conversations ? Cette action est irreversible.')) return;
    conversations = [];
    chatBox.innerHTML = '';
    fetch(`${API_BASE}/conversations`, { headers: authHeaders() })
        .then(r => r.json())
        .then(list => Promise.all(list.map(c =>
            fetch(`${API_BASE}/conversations/${c._id}`, { method: 'DELETE', headers: authHeaders() })
        )))
        .catch(() => {})
        .finally(() => createNewConversation());
};

window.clearCache = function() {
    if (!confirm('Vider le cache local ?')) return;
    const keep = ['nexus_token', 'nexus_user'];
    Object.keys(localStorage).forEach(k => { if (!keep.includes(k)) localStorage.removeItem(k); });
    updateStorageInfo();
    showToast('Cache vide.', 'success');
};

// Apply settings on page load
(function() {
    const s = loadSettings();
    window._typingSpeed = s.flashMode ? 0 : s.typingSpeed;
    document.documentElement.style.setProperty('--accent', s.accent);
    if (s.theme === 'light') document.documentElement.classList.add('theme-light');
    if (s.contrast === 'high') document.documentElement.classList.add('contrast-high');
})();

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); }
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); createNewConversation(); }
    if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        sidebar.classList.contains('hidden') ? openSidebar() : closeSidebar();
    }
});

// ===== CONVERSATION SEARCH =====
let searchQuery = '';

window.filterConversations = function(q) {
    searchQuery = q.toLowerCase().trim();
    renderConversationsList();
};

// ===== TOAST =====
window.showToast = function(msg, type = '', duration = 2400) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, duration);
};

// ===== COPY CODE BLOCK =====
window.copyCode = function(btn) {
    const code = btn.closest('.code-block-wrapper')?.querySelector('code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
        const label = btn.querySelector('span');
        if (label) label.textContent = 'Copié';
        btn.classList.add('copied');
        setTimeout(() => { if (label) label.textContent = 'Copier'; btn.classList.remove('copied'); }, 1800);
    }).catch(() => {});
};

// ===== MODE CHAT / CODE =====
function getModeConversation() { return getCurrentConversation(); }

function refreshAssistantModeUI(conv = getModeConversation()) {
    const mode = conv?.assistantMode === 'code' ? 'code' : 'chat';
    const task = Object.hasOwn(CODE_TASKS, conv?.codeTask) ? conv.codeTask : 'build';
    document.querySelectorAll('[data-assistant-mode]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.assistantMode === mode);
        btn.setAttribute('aria-pressed', String(btn.dataset.assistantMode === mode));
    });
    document.querySelectorAll('[data-code-task]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.codeTask === task);
        btn.setAttribute('aria-pressed', String(btn.dataset.codeTask === task));
    });
    const workflow = document.getElementById('code-workflow');
    if (workflow) workflow.classList.toggle('hidden', mode !== 'code');
    const studio = document.getElementById('code-studio');
    if (studio) studio.classList.toggle('hidden', mode !== 'code');
    if (mode === 'code') refreshGithubStatus();
    const hint = document.getElementById('code-workflow-hint');
    if (hint) hint.textContent = CODE_TASKS[task];
    if (userInput) userInput.placeholder = mode === 'code'
        ? 'Décris le code, les fichiers ou l’erreur à traiter…'
        : 'Écris quelque chose…';
}

window.selectAssistantMode = function(mode) {
    const conv = getModeConversation();
    if (!conv || !['chat', 'code'].includes(mode)) return;
    conv.assistantMode = mode;
    if (!conv.codeTask) conv.codeTask = 'build';
    refreshAssistantModeUI(conv);
    if (!conv._localDraft) debouncedSave(conv);
};

window.selectCodeTask = function(task) {
    const conv = getModeConversation();
    if (!conv || !Object.hasOwn(CODE_TASKS, task)) return;
    conv.assistantMode = 'code';
    conv.codeTask = task;
    refreshAssistantModeUI(conv);
    if (!conv._localDraft) debouncedSave(conv);
};

// ===== SELECTEUR DE MODELE (Groq) =====
function initModelSelector() {
    const menu = document.getElementById('model-menu');
    const nameEl = document.getElementById('current-model-name');
    if (nameEl) nameEl.textContent = currentModelLabel();
    updateProviderUI();
    if (!menu) return;
    menu.innerHTML = MODELS.map(m => `
        <button class="model-option${m.id === currentModel ? ' active' : ''}" data-model="${m.id}" onclick="selectModel('${m.id}')">
            <span class="model-option-main">${m.label}</span>
            ${m.hint ? `<span class="model-option-hint">${m.hint}</span>` : ''}
        </button>
    `).join('');
}

window.toggleModelMenu = function(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('model-menu');
    const btn = document.getElementById('model-selector-btn');
    if (!menu) return;
    const open = menu.classList.toggle('hidden');
    if (btn) btn.classList.toggle('open', !open);
};

function updateProviderUI() {
    const isGemini = currentModel.startsWith('gemini-');
    const footer = document.querySelector('.footer');
    if (footer) footer.innerHTML = '<span class="nexus-brand">NEXUS</span> · IA Avancée · ' + (isGemini ? 'Google Gemini' : 'Groq');
}

window.selectModel = function(id) {
    currentModel = id;
    localStorage.setItem('nexus_model', id);
    const nameEl = document.getElementById('current-model-name');
    if (nameEl) nameEl.textContent = currentModelLabel();
    initModelSelector();
    closeModelMenu();
    showToast('Modèle : ' + currentModelLabel(), 'success', 1600);
};

function closeModelMenu() {
    const menu = document.getElementById('model-menu');
    const btn = document.getElementById('model-selector-btn');
    if (menu) menu.classList.add('hidden');
    if (btn) btn.classList.remove('open');
}

document.addEventListener('click', (e) => {
    const sel = document.getElementById('model-selector');
    if (sel && !sel.contains(e.target)) closeModelMenu();
});

// ===== COMPTEUR DE VITESSE (Tokens/s) =====
function updateSpeedMeter(data, text, elapsedSec) {
    const meter = document.getElementById('speed-meter');
    const valEl = document.getElementById('speed-meter-value');
    if (!meter || !valEl) return;
    let tps = 0;
    // Groq renvoie parfois des métriques d'usage précises
    const usage = data && data.usage;
    if (usage && usage.completion_tokens && usage.completion_time) {
        tps = usage.completion_tokens / usage.completion_time;
    } else if (usage && usage.completion_tokens && elapsedSec > 0) {
        tps = usage.completion_tokens / elapsedSec;
    } else if (elapsedSec > 0) {
        // Estimation : ~4 caractères par token
        tps = (text.length / 4) / elapsedSec;
    }
    if (!isFinite(tps) || tps <= 0) return;
    valEl.textContent = Math.round(tps);
    meter.classList.remove('hidden');
    meter.classList.add('flash');
    setTimeout(() => meter.classList.remove('flash'), 600);
}

// ===== ONBOARDING / ECRAN D'ACCUEIL =====
const SUGGESTIONS = [
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m8 9-3 3 3 3M16 9l3 3-3 3M13.5 6l-3 12"/></svg>', title: 'Aide-moi à coder', prompt: 'Aide-moi à écrire une fonction en JavaScript qui…' },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 7.3 5.2a2 2 0 0 0 2.4 0L20.5 7"/></svg>', title: 'Rédige un email', prompt: 'Rédige un email professionnel pour…' },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 13h5M8.5 16.5h7"/></svg>', title: 'Analyse ce texte', prompt: 'Analyse et résume le texte suivant :\n\n' },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.7.6-1 1-1 2H9c0-1-.3-1.4-1-2A6 6 0 0 1 12 3z"/></svg>', title: 'Explique un concept', prompt: 'Explique-moi simplement le concept de…' },
];

function renderEmptyState() {
    if (!chatBox) return;
    const cards = SUGGESTIONS.map((s, i) => `
        <button class="suggestion-card" onclick="useSuggestion(${i})">
            <span class="suggestion-icon">${s.icon}</span>
            <span class="suggestion-title">${s.title}</span>
            <svg class="suggestion-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </button>
    `).join('');
    chatBox.innerHTML = `
        <div class="empty-state" id="empty-state">
            <div class="empty-logo"><span class="nexus-logo">NEXUS</span> <span class="ai-label">AI</span></div>
            <div class="groq-banner">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>
                ${currentModel.startsWith('gemini-') ? 'Propulsé par Google Gemini' : 'Propulsé par Groq'} — <strong>Réponses instantanées</strong>
            </div>
            <svg class="jeran-logo" viewBox="0 0 64 64" aria-label="NEXUS IA" role="img">
                <path class="j1" pathLength="100" d="M 33 11 L 16 27 L 33 43" />
                <path class="j2" pathLength="100" d="M 35 25 L 51 41 L 35 57" />
            </svg>
            <p class="empty-subtitle">Par où veux-tu commencer ?</p>
            <div class="suggestion-grid">${cards}</div>
        </div>`;
}

function removeEmptyState() {
    const el = document.getElementById('empty-state');
    if (el) el.remove();
}

window.useSuggestion = function(index) {
    const s = SUGGESTIONS[index];
    if (!s || !userInput) return;
    userInput.value = s.prompt;
    userInput.focus();
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
    // Place le curseur à la fin
    userInput.setSelectionRange(userInput.value.length, userInput.value.length);
};

// ===== CONNEXION SOCIALE (Firebase Authentication) =====
let _firebaseApp = null;

function firebaseConfigured() {
    const c = window.FIREBASE_CONFIG || {};
    return typeof firebase !== 'undefined' && c.apiKey && !String(c.apiKey).startsWith('REPLACE');
}

function initFirebase() {
    if (_firebaseApp) return _firebaseApp;
    if (!firebaseConfigured()) return null;
    _firebaseApp = firebase.apps && firebase.apps.length
        ? firebase.app()
        : firebase.initializeApp(window.FIREBASE_CONFIG);
    return _firebaseApp;
}

window.handleSocialAuth = async function(provider) {
    const label = provider === 'google' ? 'Google' : 'GitHub';
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.textContent = '';

    if (!firebaseConfigured()) {
        showToast('Connexion sociale : configure Firebase dans frontend/js/firebase-config.js', 'error', 5000);
        return;
    }

    initFirebase();
    const authProvider = provider === 'google'
        ? new firebase.auth.GoogleAuthProvider()
        : new firebase.auth.GithubAuthProvider();

    try {
        const result = await firebase.auth().signInWithPopup(authProvider);
        const idToken = await result.user.getIdToken();
        const res = await fetch(`${API_BASE}/auth/firebase`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken }),
        });
        const data = await res.json();
        if (!res.ok) {
            if (errEl) errEl.textContent = data.error || `Connexion ${label} échouée.`;
            return;
        }
        setAuth(data.token, data.user);
        // Déconnexion du SDK Firebase : on garde uniquement notre JWT applicatif
        try { await firebase.auth().signOut(); } catch {}
        initChatPage();
    } catch (e) {
        if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return;
        if (e && e.code === 'auth/account-exists-with-different-credential') {
            if (errEl) errEl.textContent = 'Un compte existe déjà avec cet email via un autre fournisseur.';
            return;
        }
        console.error('Social auth error:', e);
        const code = (e && (e.code || e.message)) ? ` (${e.code || e.message})` : '';
        if (errEl) errEl.textContent = `Connexion ${label} échouée${code}.`;
    }
};

// ===== NUMÉRO DE TÉLÉPHONE =====
function isValidPhone(raw) {
    if (typeof raw !== 'string') return false;
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 6 && digits.length <= 20;
}

// Met à jour le user stocké localement (pour ne pas re-demander)
function updateStoredUserPhone(phone) {
    const user = getUser();
    if (!user) return;
    user.phone = phone;
    localStorage.setItem('nexus_user', JSON.stringify(user));
}

async function saveUserPhone(phone) {
    const res = await fetch(`${API_BASE}/user/phone`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ phone }),
    });
    if (res.status === 401) { handleLogout(); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erreur enregistrement du numéro.');
    updateStoredUserPhone(data.user ? data.user.phone : phone);
    return true;
}

// Affiche le pop-up à la connexion si aucun numéro n'est enregistré
function maybePromptPhone() {
    const user = getUser();
    if (!user) return;
    if (user.phone && String(user.phone).trim()) return;         // déjà renseigné
    if (sessionStorage.getItem('nexus_phone_skipped')) return;    // reporté cette session
    setTimeout(openPhonePrompt, 500);
}

function openPhonePrompt() {
    const overlay = document.getElementById('phone-overlay');
    if (!overlay) return;
    const err = document.getElementById('phone-prompt-error');
    if (err) err.textContent = '';
    overlay.classList.remove('hidden');
    const input = document.getElementById('phone-prompt-input');
    if (input) { input.value = (getUser() || {}).phone || ''; setTimeout(() => input.focus(), 60); }
}

function closePhonePrompt() {
    const overlay = document.getElementById('phone-overlay');
    if (overlay) overlay.classList.add('hidden');
}

window.skipPhonePrompt = function() {
    sessionStorage.setItem('nexus_phone_skipped', '1');
    closePhonePrompt();
};

window.savePhoneFromPrompt = async function() {
    const input = document.getElementById('phone-prompt-input');
    const err   = document.getElementById('phone-prompt-error');
    const btn   = document.getElementById('phone-save-btn');
    const phone = (input?.value || '').trim();
    if (err) err.textContent = '';
    if (!isValidPhone(phone)) { if (err) err.textContent = 'Entre un numéro valide.'; return; }
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Enregistrement…';
    try {
        await saveUserPhone(phone);
        closePhonePrompt();
        showToast('Numéro enregistré.', 'success');
    } catch (e) {
        if (err) err.textContent = e.message || 'Erreur.';
    } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Enregistrer';
    }
};

window.savePhoneFromSettings = async function() {
    const input = document.getElementById('s-phone');
    const btn   = document.getElementById('s-phone-save');
    const phone = (input?.value || '').trim();
    if (phone && !isValidPhone(phone)) { showToast('Numéro invalide.', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Enregistrement…'; }
    try {
        await saveUserPhone(phone);
        showToast('Numéro mis à jour.', 'success');
        sessionStorage.setItem('nexus_phone_skipped', '1'); // ne plus re-demander
    } catch (e) {
        showToast(e.message || 'Erreur.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer'; }
    }
};

// ===== LIQUID GLASS HEADER SCROLL EFFECT =====
(function() {
    const chatBox = document.getElementById('chat-box');
    const header  = document.getElementById('nexus-header');
    if (!header) return;

    function onScroll() {
        const scrolled = chatBox ? chatBox.scrollTop > 10 : window.scrollY > 10;
        header.classList.toggle('scrolled', scrolled);
    }
    // Liquid glass class toujours active
    header.classList.add('liquid');

    if (chatBox) chatBox.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll(); // état initial
})();


// ===== DEMARRAGE SESSION =====
// Initialise la page seulement apres l'initialisation de tout l'etat du script.
if (getToken()) {
    initChatPage();
}
