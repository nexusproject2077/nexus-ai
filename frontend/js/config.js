// ===== NEXUS AI — Frontend runtime config =====
// Production backend now runs on Vercel.
window.NEXUS_CONFIG = {
    API_BASE: 'https://nexus-ai-api-self.vercel.app',
    // Groq models exposed in the in-chat model selector.
    MODELS: [
        { id: 'openai/gpt-oss-120b',    label: 'GPT-OSS · 120B', hint: 'Groq · puissant' },
        { id: 'openai/gpt-oss-20b',     label: 'GPT-OSS · 20B',  hint: 'Groq · ultra rapide' },
        { id: 'qwen/qwen3.8-27b',       label: 'Qwen 3.8 · 27B', hint: 'Groq · nouvelle génération' },
        { id: 'gemini-3.8-flash',       label: 'Gemini 3.8 Flash', hint: 'Google · dernière génération' },
        { id: 'gemini-3.5-flash-lite',  label: 'Gemini 3.5 Flash-Lite', hint: 'Google · rapide et léger' },
    ],
    DEFAULT_MODEL: 'openai/gpt-oss-120b',
};
