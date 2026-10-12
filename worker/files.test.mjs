import assert from 'node:assert/strict';
import test from 'node:test';
import { byteRange, serveFile } from './files.js';

const bytes = new TextEncoder().encode('%PDF-1.7\n0123456789abcdefghijklmnopqrstuvwxyz\n%%EOF');
const file = { storage_name: 'immutable-key', filename: "한글 '자료'(1).pdf", mime: 'application/pdf', size: bytes.length };
const metadata = { size: bytes.length, httpEtag: '"abc123"', uploaded: new Date('2026-09-30T00:00:00Z') };
function bucket() {
  const calls = [];
  return {
    calls,
    async head(key) { calls.push(['head', key]); return metadata; },
    async get(key, options) {
      calls.push(['get', key, options]);
      const r = options?.range;
      const body = r ? bytes.slice(r.offset, r.offset + r.length) : bytes;
      return { ...metadata, body: new Response(body).body };
    },
  };
}
const request = (headers = {}, method = 'GET', query = '') => new Request(`https://example.test/api/files/1${query}`, { method, headers });

for (const [value, expected] of [
  ['bytes=0-3', { offset: 0, length: 4 }], ['bytes=4-', { offset: 4, length: 6 }],
  ['bytes=-3', { offset: 7, length: 3 }], ['bytes=8-100', { offset: 8, length: 2 }],
  ['bytes=-100', { offset: 0, length: 10 }], ['bytes=10-', false], ['bytes=-0', false],
  ['bytes=6-2', null], ['bytes=0-1,3-4', null], ['items=0-1', null], ['bytes=-', null],
  ['bytes=9007199254740992-', null],
]) test(`range parsing: ${value}`, () => assert.deepEqual(byteRange(value, 10), expected));

test('full download streams exact bytes, encodes the filename and uses one R2 read', async () => {
  const b = bucket();
  const response = await serveFile(request({}, 'GET', '?download=1'), b, file, null, null);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.match(response.headers.get('content-disposition'), /%27.*%28/);
  assert.equal(response.headers.get('cache-control'), 'private, no-cache');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(b.calls.length, 1);
});

test('HEAD and matching validators never fetch file bodies', async () => {
  for (const [headers, method, status] of [
    [{ Range: 'bytes=2-5' }, 'HEAD', 200], [{ 'If-None-Match': 'W/"abc123"' }, 'GET', 304],
    [{ 'If-None-Match': '"other", "abc123"' }, 'GET', 304], [{ 'If-None-Match': '*' }, 'GET', 304],
    [{ 'If-Modified-Since': metadata.uploaded.toUTCString() }, 'GET', 304],
  ]) {
    const b = bucket();
    const r = await serveFile(request(headers, method), b, file, null, null);
    assert.equal(r.status, status); assert.equal(await r.text(), '');
    assert.deepEqual(b.calls, [['head', file.storage_name]]);
  }
});

test('nonmatching ETag takes precedence over date validators', async () => {
  const b = bucket();
  const r = await serveFile(request({ 'If-None-Match': '"other"', 'If-Modified-Since': metadata.uploaded.toUTCString() }), b, file, null, null);
  assert.equal(r.status, 200); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
});

test('ranges return exact requested bytes and correct lengths', async () => {
  for (const range of ['bytes=0-9', 'bytes=10-', 'bytes=-7', 'bytes=1-9999']) {
    const b = bucket(); const expected = byteRange(range, bytes.length);
    const r = await serveFile(request({ Range: range }), b, file, null, null);
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes ${expected.offset}-${expected.offset + expected.length - 1}/${bytes.length}`);
    assert.equal(r.headers.get('content-length'), String(expected.length));
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes.slice(expected.offset, expected.offset + expected.length));
  }
});

test('unsatisfiable ranges return 416 without fetching a body', async () => {
  const b = bucket(); const r = await serveFile(request({ Range: 'bytes=99999-' }), b, file, null, null);
  assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), `bytes */${bytes.length}`);
  assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(b.calls.length, 1);
});

test('If-Range resumes only the same version', async () => {
  for (const [tag, status] of [['"abc123"', 206], ['"different"', 200], ['W/"abc123"', 200], [metadata.uploaded.toUTCString(), 206], ['invalid', 200]]) {
    const b = bucket(); const r = await serveFile(request({ Range: 'bytes=5-9', 'If-Range': tag }), b, file, null, null);
    assert.equal(r.status, status); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), status === 206 ? bytes.slice(5, 10) : bytes);
  }
});

test('cache hits skip R2 and preserve inline/download intent', async () => {
  const b = bucket();
  let matched;
  const cache = { async match(r) { matched = r; return new Response(bytes, { headers: { 'Cache-Control': 'public, max-age=86400', 'ETag': metadata.httpEtag } }); } };
  const r = await serveFile(request({}, 'GET', '?download=1'), b, file, null, cache);
  assert.equal(new URL(matched.url).pathname, '/__file-cache/v1/immutable-key');
  assert.equal(b.calls.length, 0); assert.match(r.headers.get('content-disposition'), /^attachment;/);
  assert.equal(r.headers.get('cache-control'), 'private, no-cache'); await r.arrayBuffer();
});

test('cache errors fall back to R2 and only complete responses populate cache', async () => {
  const pending = []; const puts = [];
  const cache = { async match() { throw new Error('cache unavailable'); }, async put(key, response) { puts.push({ key, status: response.status, body: await response.arrayBuffer() }); } };
  for (const headers of [{}, { Range: 'bytes=0-5' }]) {
    const r = await serveFile(request(headers), bucket(), file, { waitUntil(p) { pending.push(p); } }, cache);
    await r.arrayBuffer();
  }
  await Promise.all(pending); assert.equal(puts.length, 1);
  assert.deepEqual(new Uint8Array(puts[0].body), bytes);
});

test('missing R2 object returns 404 rather than a success or cached error', async () => {
  const r = await serveFile(request(), { async get() { return null; } }, file, null, null);
  assert.equal(r.status, 404);
});
