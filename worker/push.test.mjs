import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pushApi, testHelpers } from './push.js';

const crypto = webcrypto;
const encoder = new TextEncoder();

function concat(...parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function encode64(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

test('aes128gcm payload can be decrypted by a subscriber', async () => {
  const subscriber = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const subscriberPublic = new Uint8Array(await crypto.subtle.exportKey('raw', subscriber.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const payload = { title: '일정 알림', body: '시험 하루 전', url: '/calendar', silent: true };
  const encoded = await testHelpers.encryptedPayload({ p256dh: encode64(subscriberPublic), auth: encode64(auth) }, payload);
  assert.equal(encoded[20], 65);
  assert.equal(new DataView(encoded.buffer).getUint32(16), 4096);
  const salt = encoded.slice(0, 16);
  const senderPublic = encoded.slice(21, 86);
  const senderKey = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, subscriber.privateKey, 256);
  const sharedKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const ikm = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: auth,
    info: concat(encoder.encode('WebPush: info\0'), subscriberPublic, senderPublic) }, sharedKey, 256);
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt,
    info: encoder.encode('Content-Encoding: aes128gcm\0') }, ikmKey, 128);
  const nonce = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt,
    info: encoder.encode('Content-Encoding: nonce\0') }, ikmKey, 96);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, encoded.slice(86)));
  assert.equal(decrypted.at(-1), 2);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decrypted.slice(0, -1))), payload);
});

test('VAPID JWT signs for the exact push origin', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const token = await testHelpers.vapidToken({ VAPID_PRIVATE_JWK: JSON.stringify(privateJwk) },
    'https://fcm.googleapis.com/fcm/send/opaque');
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(parts[2], 'base64url'), encoder.encode(`${parts[0]}.${parts[1]}`)));
});

test('Korea date and event offsets cross a UTC date boundary', () => {
  assert.equal(testHelpers.koreaDate(Date.parse('2026-09-30T22:00:00Z')), '2026-10-01');
  assert.equal(testHelpers.addDays('2026-10-01', 7), '2026-10-08');
  assert.equal(testHelpers.dueEventNotice([{ title: '수행평가', days_until: 1 }]).body,
    '하루 전 · 수행평가');
});

test('NEIS meals are fetched once for the Korean day and rendered as plain text', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return Response.json({ mealServiceDietInfo: [
      { head: [] },
      { row: [
        { MLSV_YMD: '20260930', MMEAL_SC_CODE: '1', DDISH_NM: '밥<br/>국 (5.6)' },
        { MLSV_YMD: '20260930', MMEAL_SC_CODE: '2', DDISH_NM: '면<br />과일' },
      ] },
    ] });
  };
  try {
    const notice = await testHelpers.fetchNeisMeals({ NEIS_API_KEY: 'test-only',
      NEIS_EDUCATION_OFFICE_CODE: 'D10', NEIS_SCHOOL_CODE: '7240060' }, '2026-09-30');
    assert.equal(requestedUrl.hostname, 'open.neis.go.kr');
    assert.equal(requestedUrl.searchParams.get('MLSV_YMD'), '20260930');
    assert.equal(requestedUrl.searchParams.get('SD_SCHUL_CODE'), '7240060');
    assert.match(notice.body, /아침: 밥, 국/);
    assert.match(notice.body, /점심: 면, 과일/);
    assert.ok(!notice.body.includes('<'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('new subscriptions are limited per IP and unsubscribe requires the auth secret', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) { return {
    first: async () => sqlite.prepare(sql).get(...args) || null,
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...args).changes } }),
  }; } }; } };
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const browser = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const env = { DB: db,
    VAPID_PUBLIC_KEY: encode64(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey))),
    VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', vapid.privateKey)) };
  const p256dh = encode64(new Uint8Array(await crypto.subtle.exportKey('raw', browser.publicKey)));
  const auth = encode64(crypto.getRandomValues(new Uint8Array(16)));
  const route = '/api/push/subscriptions';
  const endpoint = (id) => `https://fcm.googleapis.com/fcm/send/${id}`;
  const call = async (method, body, ip = '192.0.2.1') => {
    const request = new Request(`https://2-4.cloud${route}`, { method,
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) });
    return pushApi(request, env, route);
  };
  const subscribe = (id, secret = auth) => ({ subscription: {
    endpoint: endpoint(id), keys: { p256dh, auth: secret },
  } });
  for (const id of Array.from({ length: 25 }, (_, index) => `device-${index}`)) {
    assert.equal((await call('POST', subscribe(id))).status, 200);
  }
  assert.equal((await call('POST', subscribe('device-0'))).status, 200); // existing device does not count again
  assert.equal((await call('POST', subscribe('device-25'))).status, 429);
  assert.equal((await call('POST', subscribe('device-25'), '192.0.2.2')).status, 200);
  assert.equal((await call('POST', subscribe('device-0', encode64(new Uint8Array(16))))).status, 403);
  assert.equal((await call('DELETE', { endpoint: endpoint('device-0'), auth: encode64(new Uint8Array(16)) })).status, 403);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 26);
  assert.equal((await call('DELETE', { endpoint: endpoint('device-0'), auth })).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 25);
  sqlite.close();
});
