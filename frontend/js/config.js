// ===== NEXUS AI — Frontend runtime config =====
// Production backend now runs on Vercel.
window.NEXUS_CONFIG = {
    API_BASE: 'https://nexus-ai-api-self.vercel.app',
    // Groq models exposed in the in-chat model selector.
    MODELS: [
        { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 · 70B', hint: 'Groq · le plus puissant' },
        { id: 'llama-3.1-8b-instant',   label: 'Llama 3.1 · 8B',  hint: 'Groq · ultra rapide' },
        { id: 'mixtral-8x7b-32768',     label: 'Mixtral · 8x7B',  hint: 'Groq · grand contexte' },
        { id: 'gemma2-9b-it',           label: 'Gemma 2 · 9B',    hint: 'Groq · léger' },
        { id: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash', hint: 'Google · gros documents' },
        { id: 'gemini-2.5-flash-lite',  label: 'Gemini 2.5 Flash-Lite', hint: 'Google · rapide' },
    ],
    DEFAULT_MODEL: 'llama-3.3-70b-versatile',
};
