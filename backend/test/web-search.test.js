import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb } from '../web-search.js';

test('Tavily and Brave use their authentication, cap results and reject unsafe URLs', async () => {
  for (const provider of ['tavily', 'brave']) {
    let called = false;
    const results = await searchWeb({ provider, key: 'test-secret', query: 'test query', maxResults: 100, fetchImpl: async (url, options) => {
      called = true;
      if (provider === 'tavily') {
        assert.equal(options.headers.Authorization, 'Bearer test-secret');
        assert.equal(JSON.parse(options.body).max_results, 10);
        assert.equal(JSON.parse(options.body).query, 'test query');
      } else {
        assert.equal(options.headers['X-Subscription-Token'], 'test-secret');
        assert.equal(new URL(url).searchParams.get('count'), '10');
      }
      const raw = [{ title: 'Source', url: 'https://example.com', content: 'Content', description: 'Description' }, { url: 'javascript:alert(1)' }];
      return { ok: true, json: async () => provider === 'tavily' ? { results: raw } : { web: { results: raw } } };
    } });
    assert.equal(called, true); assert.equal(results.length, 1);
  }
  for (const status of [401, 429, 500]) {
    await assert.rejects(searchWeb({ provider: 'brave', key: 'test', query: 'query', fetchImpl: async () => ({ ok: false, status }) }), error => !!error.status && !error.message.includes('test'));
  }
  await assert.rejects(searchWeb({ provider: 'tavily', key: '', query: 'query' }), { status: 409 });
});

process.env.VERCEL = '1'; process.env.MONGODB_URI = ''; process.env.USE_FIRESTORE = 'false';
process.env.JWT_SECRET = 'web-search-isolated-test-secret';
const { default: app } = await import('../server.js');
const { getStore } = await import('../store.js');
test('keys stay encrypted, never appear in settings/export and search requires an authenticated account', async () => {
  const server = app.listen(0);
  const originalFetch = globalThis.fetch;
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, token, body, method = body ? 'POST' : 'GET') {
    const r = await originalFetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  }
  try {
    const registration = await request('/auth/register', null, { email: 'search@example.test', username: 'Search', password: 'test-password-123' });
    const token = registration.data.token;
    assert.equal((await request('/web/search', null, { query: 'query' })).status, 401);
    assert.equal((await request('/web/search', token, { query: 'query' })).status, 409);
    await request('/user/settings', token, { settings: { webSearchProvider: 'tavily', webSearchKey: 'private-test-key' } }, 'PUT');
    const user = await (await getStore()).usersGetById(registration.data.user.id);
    assert.ok(user.webSearchSecrets.tavily); assert.equal(JSON.stringify(user).includes('private-test-key'), false);
    for (const path of ['/user/settings', '/user/export']) assert.equal(JSON.stringify((await request(path, token)).data).includes('private-test-key'), false);
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.tavily.com/search');
      assert.equal(options.headers.Authorization, 'Bearer private-test-key');
      return { ok: true, json: async () => ({ results: [{ title: 'Real provider shape', url: 'https://example.com', content: 'Snippet' }] }) };
    };
    assert.equal((await request('/web/search', token, { query: 'query' })).data.results.length, 1);
    await request('/user/settings', token, { settings: { webSearchProvider: 'tavily', webSearchKey: '' } }, 'PUT');
    assert.equal((await request('/web/search', token, { query: 'query' })).status, 200);
    assert.equal((await request('/web/search', token, { query: 'query', provider: 'brave' })).status, 409);
    await request('/user/settings', token, { settings: { webSearchProvider: 'tavily', webSearchClearKey: true } }, 'PUT');
    assert.equal((await request('/web/search', token, { query: 'query' })).status, 409);
  } finally { globalThis.fetch = originalFetch; await new Promise(resolve => server.close(resolve)); }
});
