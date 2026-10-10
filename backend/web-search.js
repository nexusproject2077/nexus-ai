// Provider requests are made on the server to avoid browser CORS failures.
export async function searchWeb({ provider, key, query, maxResults = 5, fetchImpl = fetch }) {
  if (!['tavily', 'brave'].includes(provider)) throw Object.assign(new Error('Fournisseur de recherche invalide.'), { status: 400 });
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw Object.assign(new Error('Saisissez une recherche de 1 à 2 000 caractères.'), { status: 400 });
  if (!key) throw Object.assign(new Error('Ajoutez une clé API pour ce fournisseur dans Réglages › Applications.'), { status: 409 });
  const count = Math.max(1, Math.min(10, Number.parseInt(maxResults, 10) || 5));
  const url = provider === 'tavily' ? 'https://api.tavily.com/search' : 'https://api.search.brave.com/res/v1/web/search?' + new URLSearchParams({ q: query.trim(), count: String(count) });
  let response;
  try {
    response = await fetchImpl(url, provider === 'tavily' ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ query: query.trim(), max_results: count, search_depth: 'basic', include_answer: false }), signal: AbortSignal.timeout(15000)
    } : { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(15000) });
  } catch { throw Object.assign(new Error('Le fournisseur ne répond pas. Réessayez dans un instant.'), { status: 502 }); }
  if (!response.ok) {
    const message = [401, 403].includes(response.status) ? 'Clé API refusée. Vérifiez la clé et son abonnement.'
      : [402, 429].includes(response.status) ? 'Quota de recherche atteint ou trop de demandes. Vérifiez votre compte fournisseur.'
      : 'Recherche indisponible chez le fournisseur (' + response.status + ').';
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 });
  }
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error('Réponse du fournisseur illisible.'), { status: 502 }); }
  const raw = provider === 'tavily' ? data.results : data.web?.results;
  return (Array.isArray(raw) ? raw : []).filter(r => typeof r.url === 'string' && /^https?:\/\//i.test(r.url)).slice(0, count)
    .map(r => ({ title: String(r.title || '').slice(0, 500), url: r.url, snippet: String(r.content || r.description || '').slice(0, 6000) }));
}
