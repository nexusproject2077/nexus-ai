import test from 'node:test';
import assert from 'node:assert/strict';
import { durationExample } from '../duration-example.js';

test('duration example is visibly invalid, uses Paris time and adds 75 minutes', () => {
  const result = durationExample({ minutes: 75, phone: '+33600000000', sentAt: '2026-10-10T08:10:00Z' });
  assert.ok(result.text.startsWith('EXEMPLE / NON VALIDE'));
  assert.ok(result.text.includes('De 10:10 à 11:25'));
  assert.ok(result.text.includes('Date : 10.10.26'));
  assert.ok(result.text.includes('Téléphone : +33600000000'));
  assert.match(result.reference, /^\d{2}('\d{2}){5}$/);
  assert.equal(new Date(result.endsAt) - new Date(result.sentAt), 75 * 60000);
  assert.ok(result.text.includes('Code de démonstration : DEMO-'));
});
test('duration example handles midnight and absent phone without a hardcoded fallback', () => {
  const result = durationExample({ minutes: 75, sentAt: '2026-10-10T21:50:00Z' });
  assert.ok(result.text.includes('De 23:50 à 01:05 le 11.10.26'));
  assert.ok(result.text.includes('Non renseigné dans le compte'));
  assert.throws(() => durationExample({ minutes: 15 }));
});
process.env.VERCEL = '1'; process.env.MONGODB_URI = ''; process.env.USE_FIRESTORE = 'false'; process.env.JWT_SECRET = 'isolated-demo-test-secret';
const { default: app } = await import('../server.js');
test('example route gets phone from the server account, rejects unauthenticated or stale requests', async () => {
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, body, token, method = 'POST') => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, ...await r.json() };
  };
  try {
    const account = await request('/auth/register', { email: 'demo@example.test', username: 'Demo', password: 'demo-password' });
    await request('/user/phone', { phone: '+33612345678' }, account.token, 'PUT');
    const example = await request('/user/duration-example', { minutes: 75, sentAt: new Date().toISOString(), phone: 'attacker-input' }, account.token);
    assert.equal(example.status, 200); assert.ok(example.text.includes('Téléphone : +33612345678'));
    assert.ok(!example.text.includes('attacker-input'));
    assert.equal((await request('/user/duration-example', { minutes: 75 })).status, 401);
    assert.equal((await request('/user/duration-example', { minutes: 75, sentAt: '2020-01-01' }, account.token)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
