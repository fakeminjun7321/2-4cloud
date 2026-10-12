import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

test('a slow read times out with a recoverable message and no retry', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await assert.rejects(api('/bootstrap', { timeoutMs: 10 }), /서버 응답이 늦어지고/);
  assert.equal(calls, 1);
});

test('read timeout covers a stalled response body', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }));
  await assert.rejects(api('/bootstrap', { timeoutMs: 10 }), /서버 응답이 늦어지고/);
});

test('HTML errors and null JSON cannot silently become successful bootstrap data', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>upstream error</html>', { status: 502 }));
  await assert.rejects(api('/bootstrap'), /서버 응답을 확인할 수 없어요/);
  globalThis.fetch = async () => Response.json(null);
  await assert.rejects(api('/bootstrap'), /서버 응답을 확인할 수 없어요/);
});

test('mutation failure is surfaced once without automatic retry', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ detail: '업로드를 확인해 주세요.' }, { status: 500 }); });
  await assert.rejects(api('/materials', { method: 'POST' }), /업로드를 확인/);
  assert.equal(calls, 1);
});
