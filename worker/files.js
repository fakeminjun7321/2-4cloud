// R2 keys are immutable. Look up the D1 attachment before using this cache so
// deleted attachments and reused numeric IDs cannot expose an old object.
const EDGE_TTL = 86400;
// A cloned stream can buffer behind a slow reader. Keep large PDFs on the
// direct streaming path instead of duplicating tens of MiB in Worker memory.
const MAX_EDGE_CACHE_BYTES = 8 * 1024 * 1024;

function disposition(filename, download) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// null: ignore malformed/unsupported ranges. false: a valid but empty range.
export function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first !== null && last !== null && last < first) return null;
  if (!size || (first === null && !last) || (first !== null && first >= size)) return false;
  const offset = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  return { offset, length: end - offset + 1 };
}

function unchanged(request, object) {
  const tag = request.headers.get('If-None-Match');
  if (tag !== null) return tag.split(',').some((value) => value.trim() === '*'
    || value.trim().replace(/^W\//, '') === object.httpEtag);
  const since = Date.parse(request.headers.get('If-Modified-Since') || '');
  return Number.isFinite(since) && Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(since / 1000);
}

function canResume(request, object) {
  const value = request.headers.get('If-Range');
  if (!value) return true;
  if (value.startsWith('"') || value.startsWith('W/')) return value === object.httpEtag;
  const date = Date.parse(value);
  return Number.isFinite(date) && Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(date / 1000);
}

function objectHeaders(object) {
  return new Headers({
    'Content-Length': String(object.size),
    'Accept-Ranges': 'bytes',
    'ETag': object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
  });
}

function forClient(response, request, file) {
  const headers = new Headers(response.headers);
  headers.set('Content-Type', file.mime);
  headers.set('Content-Disposition', disposition(file.filename, new URL(request.url).searchParams.get('download') === '1'));
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  // Revalidate against D1 even after deletion or reuse of an attachment ID.
  headers.set('Cache-Control', 'private, no-cache');
  return new Response(response.body, { status: response.status, headers });
}

function missing() {
  return Response.json({ detail: '파일을 찾을 수 없어요.' }, { status: 404 });
}

export async function serveFile(request, bucket, file, ctx, cache) {
  if (cache === undefined && globalThis.caches) {
    try {
      // Keep internal object keys separate from the public/default HTTP cache.
      cache = await caches.open('2-4-cloud-files-v1');
    } catch {
      cache = null;
    }
  }
  const cacheKey = new Request(new URL(`/__file-cache/v1/${encodeURIComponent(file.storage_name)}`, request.url));
  // Cache API handles Range and validators, but not If-Range. Evaluate that in
  // the R2 path instead. HEAD must never open an R2 body stream.
  const requestedRange = byteRange(request.headers.get('Range'), file.size);
  const canUseCache = request.method === 'GET' && !request.headers.has('If-Range')
    && (!request.headers.has('Range') || Boolean(requestedRange));
  if (cache && canUseCache && file.size <= MAX_EDGE_CACHE_BYTES) {
    const headers = new Headers();
    for (const name of ['Range', 'If-None-Match', 'If-Modified-Since']) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    // HTTP gives If-None-Match precedence over If-Modified-Since.
    if (headers.has('If-None-Match')) headers.delete('If-Modified-Since');
    try {
      const hit = await cache.match(new Request(cacheKey, { headers }));
      if (hit && [200, 206, 304].includes(hit.status)) return forClient(hit, request, file);
    } catch {
      // A cache outage must not prevent downloading the original file.
    }
  }

  const needsHead = request.method === 'HEAD' || request.headers.has('Range')
    || request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since');
  let object = needsHead ? await bucket.head(file.storage_name) : await bucket.get(file.storage_name);
  if (!object) return missing();
  const headers = objectHeaders(object);
  if (unchanged(request, object)) {
    headers.delete('Content-Length');
    return forClient(new Response(null, { status: 304, headers }), request, file);
  }
  if (request.method === 'HEAD') return forClient(new Response(null, { headers }), request, file);

  const range = canResume(request, object) ? byteRange(request.headers.get('Range'), object.size) : null;
  if (range === false) {
    headers.set('Content-Range', `bytes */${object.size}`);
    headers.set('Content-Length', '0');
    headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 416, headers });
  }
  if (needsHead) object = await bucket.get(file.storage_name, range ? { range } : undefined);
  if (!object?.body) return missing();
  let status = 200;
  if (range) {
    status = 206;
    headers.set('Content-Length', String(range.length));
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  }
  const response = new Response(object.body, { status, headers });
  if (cache && ctx && status === 200 && object.size <= MAX_EDGE_CACHE_BYTES) {
    const cached = response.clone();
    cached.headers.set('Cache-Control', `public, max-age=${EDGE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, cached).catch(() => {
      console.warn(JSON.stringify({ operation: 'file_cache_write', status: 'failed' }));
    }));
  }
  return forClient(response, request, file);
}
