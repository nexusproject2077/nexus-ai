import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise real HTTP routes against isolated storage, never production data.
process.env.VERCEL = '1';
process.env.MONGODB_URI = '';
process.env.USE_FIRESTORE = 'false';
process.env.JWT_SECRET = 'isolated-data-management-test-secret';
const { default: app } = await import('../server.js');

test('export is complete and private; bulk deletion is account-scoped and persistent', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, token, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  try {
    const register = email => request('/auth/register', null, { username: 'Test', email, password: 'test-password-123' });
    const owner = (await register('owner@example.test')).data.token;
    const other = (await register('other@example.test')).data.token;
    const ownerSecond = (await request('/auth/login', null, { email: 'owner@example.test', password: 'test-password-123' })).data.token;
    const conversation = (await request('/conversations', owner, {})).data;
    await request('/conversations/' + conversation._id, owner, { title: 'Export me', messages: [{ role: 'user', content: 'Full message' }], history: [{ role: 'user', content: 'Full history' }] }, 'PUT');
    await request('/conversations', other, {});
    await request('/user/memory', owner, { memory: ['Saved memory'] }, 'PUT');
    await request('/user/settings', owner, { settings: { alias: 'Saved alias', modelImprove: true } }, 'PUT');
    assert.equal((await request('/user/settings', owner)).data.settings.modelImprove, false);
    const exported = await request('/user/export', owner);
    assert.equal(exported.status, 200);
    assert.equal(exported.data.conversations.length, 1);
    assert.equal(exported.data.conversations[0].messages[0].content, 'Full message');
    assert.equal(exported.data.conversations[0].history[0].content, 'Full history');
    assert.deepEqual(exported.data.memory, ['Saved memory']);
    assert.equal(exported.data.settings.alias, 'Saved alias');
    for (const secret of ['passwordHash', 'totpSecret', 'twoFactorBackupHashes', 'sessionVersion']) {
      assert.equal(Object.hasOwn(exported.data.user, secret), false);
      assert.equal(JSON.stringify(exported.data).includes('"' + secret + '"'), false);
    }
    assert.equal((await request('/user/export')).status, 401);
    assert.equal((await request('/conversations', null, null, 'DELETE')).status, 401);
    const deleted = await request('/conversations', owner, null, 'DELETE');
    assert.deepEqual(deleted.data, { ok: true, deletedCount: 1 });
    assert.deepEqual((await request('/conversations', ownerSecond)).data, []);
    assert.equal((await request('/conversations', other)).data.length, 1);
    assert.equal((await request('/user/export', owner)).data.conversations.length, 0);
    assert.deepEqual((await request('/user/export', owner)).data.memory, ['Saved memory']);
    assert.equal((await request('/conversations', owner, null, 'DELETE')).data.deletedCount, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
