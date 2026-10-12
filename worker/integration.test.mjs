import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, db, bucket;
let origin;
const pdf = Buffer.from('%PDF-1.7\nlocal transfer fixture\n%%EOF');
let cookie;
const fetchApi = (path, init = {}) => fetch(`${origin}${path}`, init);
const adminHeaders = () => ({ Origin: origin, Cookie: cookie });

test.before(async () => {
  const root = new URL('./', import.meta.url).pathname;
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['index.js', 'push.js', 'files.js'].map(name => ({ type: 'ESModule', path: root + name })),
    name: 'archive-integration', modulesRoot: root, compatibilityDate: '2026-09-30',
    d1Databases: ['DB'], r2Buckets: ['FILES'],
    bindings: { ADMIN_PASSWORD_SHA256: createHash('sha256').update('local-test-only').digest('hex') },
  }));
  origin = new URL(await mf.ready).origin;
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('FILES');
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await db.batch(schema.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const login = await fetchApi('/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'local-test-only' }) });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0]; await login.json();
});
test.after(async () => { await mf?.dispose(); });

async function upload(title, filename, content = pdf) {
  const body = new FormData();
  body.set('title', title); body.set('subject_id', '1'); body.set('kind', '학습지');
  body.append('files', new File([content], filename, { type: 'application/pdf' }));
  body.append('sha256', createHash('sha256').update(content).digest('hex'));
  const r = await fetchApi('/api/materials', { method: 'POST', headers: adminHeaders(), body });
  assert.equal(r.status, 200, await r.clone().text());
  const material = await r.json();
  const row = await db.prepare('SELECT * FROM attachments WHERE material_id = ?').bind(material.id).first();
  return { material, row };
}

test('real local login -> multipart upload -> D1/R2 persistence -> download preserves bytes', async () => {
  const { row } = await upload('로컬 업로드 검증', "자료 '한글'(1).pdf");
  assert.deepEqual(Buffer.from(await (await bucket.get(row.storage_name)).arrayBuffer()), pdf);
  const r = await fetchApi(`/api/files/${row.id}?download=1`);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /^attachment;/);
  assert.match(r.headers.get('content-disposition'), /%27/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), pdf);
});

test('bootstrap batch preserves associations and never caches admin state', async () => {
  const anonymous = await fetchApi('/api/bootstrap');
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  const body = await anonymous.json();
  assert.equal(body.admin, false); assert.equal(body.subjects.length, 12); assert.equal(body.teachers.length, 20);
  assert.equal(body.materials[0].attachments.length, 1);
  const admin = await fetchApi('/api/bootstrap', { headers: { Cookie: cookie } });
  assert.equal((await admin.json()).admin, true);
});

test('R2 and warmed edge cache both support ranges, validators and content disposition', async () => {
  const { row } = await upload('부분 다운로드 검증', 'ranges.pdf');
  const path = `/api/files/${row.id}`;
  const cold = await fetchApi(path, { headers: { Range: 'bytes=2-7' } });
  assert.equal(cold.status, 206); assert.deepEqual(Buffer.from(await cold.arrayBuffer()), pdf.subarray(2, 8));
  const full = await fetchApi(path); const etag = full.headers.get('etag'); const modified = full.headers.get('last-modified');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), pdf);
  const cached = await fetchApi(`${path}?download=1`, { headers: { Range: 'bytes=-5' } });
  assert.equal(cached.status, 206); assert.match(cached.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), pdf.subarray(-5));
  const conditional = await fetchApi(path, { headers: { 'If-None-Match': etag } });
  assert.equal(conditional.status, 304); assert.equal(await conditional.text(), '');
  const changed = await fetchApi(path, { headers: { 'If-None-Match': '"stale"', 'If-Modified-Since': modified } });
  assert.equal(changed.status, 200); await changed.arrayBuffer();
  const resume = await fetchApi(path, { headers: { Range: 'bytes=10-', 'If-Range': etag } });
  assert.equal(resume.status, 206); assert.deepEqual(Buffer.from(await resume.arrayBuffer()), pdf.subarray(10));
  const mismatch = await fetchApi(path, { headers: { Range: 'bytes=10-', 'If-Range': '"old"' } });
  assert.equal(mismatch.status, 200); assert.deepEqual(Buffer.from(await mismatch.arrayBuffer()), pdf);
  const caches = await mf.getCaches();
  const key = `${origin}/__file-cache/v1/${row.storage_name}`;
  const cache = await caches.open('2-4-cloud-files-v1');
  const cachedObject = await cache.match(key);
  assert.ok(cachedObject, 'the full response must be stored by waitUntil');
  await cachedObject.arrayBuffer();
  await bucket.delete(row.storage_name);
  const fromCache = await fetchApi(path, { headers: { Range: 'bytes=1-3' } });
  assert.equal(fromCache.status, 206); assert.deepEqual(Buffer.from(await fromCache.arrayBuffer()), pdf.subarray(1,4));
  const weakTag = await fetchApi(path, { headers: { 'If-None-Match': `W/${etag}` } });
  assert.equal(weakTag.status, 304); await weakTag.text();
});

test('HEAD, invalid ranges and missing objects have valid HTTP framing', async () => {
  const { row } = await upload('응답 헤더 검증', 'headers.pdf');
  const path = `/api/files/${row.id}`;
  const head = await fetchApi(path, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(pdf.length));
  assert.equal(await head.text(), '');
  const invalid = await fetchApi(path, { headers: { Range: 'bytes=999999-' } });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${pdf.length}`);
  assert.equal(await invalid.text(), '');
  await bucket.delete(row.storage_name);
  const missing = await fetchApi(path);
  assert.equal(missing.status, 404); assert.equal(missing.headers.get('cache-control'), 'no-store');
});

test('deleted files cannot leak from edge cache, including when D1 reuses an ID', async () => {
  const { row, material } = await upload('삭제 검증', 'old.pdf');
  const warm = await fetchApi(`/api/files/${row.id}`); await warm.arrayBuffer();
  const removed = await fetchApi(`/api/materials/${material.id}`, { method: 'DELETE', headers: adminHeaders() });
  assert.equal(removed.status, 200); await removed.json();
  const gone = await fetchApi(`/api/files/${row.id}`); assert.equal(gone.status, 404); await gone.text();
  const replacement = Buffer.from('%PDF-1.7\nnew immutable content\n%%EOF');
  const fresh = await upload('새 파일', 'new.pdf', replacement);
  assert.equal(fresh.row.id, row.id);
  const r = await fetchApi(`/api/files/${row.id}`); assert.deepEqual(Buffer.from(await r.arrayBuffer()), replacement);
});

test('44 MiB file supports 1 KiB partial reads and exact full streaming download', async () => {
  const large = Buffer.alloc(44 * 1024 * 1024, 67); pdf.copy(large);
  await bucket.put('large-stream-fixture', large);
  const material = await db.prepare("INSERT INTO materials (title,subject_id,kind) VALUES ('큰 파일',1,'학습지')").run();
  const inserted = await db.prepare('INSERT INTO attachments (material_id,filename,mime,size,storage_name) VALUES (?,?,?,?,?)').bind(material.meta.last_row_id, 'large.pdf', 'application/pdf', large.length, 'large-stream-fixture').run();
  const path = `/api/files/${inserted.meta.last_row_id}`;
  const part = await fetchApi(path, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-length'), '1024');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), large.subarray(0,1024));
  const full = await fetchApi(`${path}?download=1`);
  assert.equal(full.status, 200);
  const hash = createHash('sha256'); let length=0;
  for await (const chunk of full.body) { length+=chunk.length; hash.update(chunk); }
  assert.equal(length,large.length); assert.equal(hash.digest('hex'),createHash('sha256').update(large).digest('hex'));
  const caches = await mf.getCaches();
  const cache = await caches.open('2-4-cloud-files-v1');
  assert.equal(await cache.match(`${origin}/__file-cache/v1/large-stream-fixture`), undefined,
    'large bodies must not be cloned into the edge cache');
});
