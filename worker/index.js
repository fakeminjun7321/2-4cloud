// Cloudflare bindings: DB (D1), FILES (R2), ASSETS (static build),
// ADMIN_PASSWORD_SHA256 (secret; SHA-256 hex of the UTF-8 admin password).
import { pushApi, sendDueNotifications } from './push.js';
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 24;
const MAX_JSON_BYTES = 16 * 1024;
const KINDS = new Set(['필기', '학습지', '시험범위', '기타']);
const EVENT_TYPES = new Set(['시험', '수행평가', '제출', '기타']);
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function fail(status, detail) {
  throw new HttpError(status, detail);
}

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers });
}

function routeId(path, pattern) {
  const match = path.match(pattern);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function requireSameOrigin(request) {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  let actual;
  try {
    actual = origin || (referer ? new URL(referer).origin : null);
  } catch {
    actual = null;
  }
  if (actual !== expected) fail(403, '허용되지 않은 요청이에요.');
}

function cookieToken(request) {
  const match = request.headers.get('Cookie')?.match(/(?:^|;\s*)archive_session=([^;]+)/);
  return match ? match[1] : null;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function sha256Blob(blob) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())));
}

function constantTimeHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function isAdmin(request, env) {
  const token = cookieToken(request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare('SELECT 1 AS valid FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  return Boolean(row);
}

async function requireAdmin(request, env) {
  if (!(await isAdmin(request, env))) fail(401, '관리자 로그인이 필요해요.');
}

function cleanText(value, label, limit) {
  if (typeof value !== 'string') fail(400, `${label}을(를) 입력해 주세요.`);
  const cleaned = value.trim();
  if (!cleaned || Array.from(cleaned).length > limit) fail(400, `${label}은(는) 1~${limit}자로 입력해 주세요.`);
  return cleaned;
}

function optionalText(value, label, limit) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  if (Array.from(cleaned).length > limit) fail(400, `${label}은(는) ${limit}자 이하로 입력해 주세요.`);
  return cleaned;
}

function integerId(value, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(400, `${label}을(를) 확인해 주세요.`);
  return parsed;
}

async function validateSubjectTeacher(db, subjectId, teacherId) {
  if (subjectId !== null) {
    const subject = await db.prepare('SELECT 1 AS valid FROM subjects WHERE id = ?').bind(subjectId).first();
    if (!subject) fail(400, '존재하지 않는 과목이에요.');
  }
  if (teacherId !== null) {
    const teacher = await db.prepare('SELECT 1 AS valid FROM teachers WHERE id = ? AND subject_id = ?')
      .bind(teacherId, subjectId).first();
    if (!teacher) fail(400, '선택한 과목의 선생님이 아니에요.');
  }
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, '날짜를 확인해 주세요.');
  const day = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value || value.startsWith('0000')) {
    fail(400, '날짜를 확인해 주세요.');
  }
  return value;
}

async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    fail(415, 'JSON 요청이 필요해요.');
  }
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) fail(413, '요청이 너무 커요.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, '요청 내용을 확인해 주세요.');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      fail(413, '요청이 너무 커요.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    fail(400, '요청 내용을 확인해 주세요.');
  }
}

async function readForm(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) fail(413, '한 번에 올릴 수 있는 용량을 초과했어요.');
  try {
    return await request.formData();
  } catch {
    fail(400, '업로드 내용을 확인해 주세요.');
  }
}

function fileMime(name, signature) {
  const lower = name.toLowerCase();
  const starts = (...bytes) => bytes.every((byte, index) => signature[index] === byte);
  if (lower.endsWith('.pdf') && starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  if ((lower.endsWith('.jpg') || lower.endsWith('.jpeg')) && starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (lower.endsWith('.png') && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (lower.endsWith('.webp') && starts(0x52, 0x49, 0x46, 0x46)
      && signature[8] === 0x57 && signature[9] === 0x45 && signature[10] === 0x42 && signature[11] === 0x50) {
    return 'image/webp';
  }
  fail(400, 'PDF, JPG, PNG, WEBP 파일만 올릴 수 있어요.');
}

async function preparedFiles(form) {
  const entries = form.getAll('files');
  if (entries.length > MAX_FILES) fail(400, `파일은 한 번에 ${MAX_FILES}개까지 올릴 수 있어요.`);
  let total = 0;
  const files = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.slice !== 'function') {
      fail(400, '파일을 확인해 주세요.');
    }
    const filename = entry.name.split(/[\\/]/).pop()?.trim() || '';
    if (!filename || Array.from(filename).length > 180 || /[\x00-\x1f\x7f]/.test(filename)) {
      fail(400, '파일 이름을 확인해 주세요.');
    }
    if (entry.size > MAX_FILE_BYTES) fail(413, '파일 하나는 20MB 이하로 올려 주세요.');
    total += entry.size;
    if (total > MAX_REQUEST_BYTES) fail(413, '한 번에 올릴 수 있는 용량을 초과했어요.');
    const signature = new Uint8Array(await entry.slice(0, 12).arrayBuffer());
    files.push({ blob: entry, filename, mime: fileMime(filename, signature), size: entry.size,
      digest: await sha256Blob(entry), storageName: crypto.randomUUID().replaceAll('-', '') });
  }
  return files;
}

async function storeFiles(env, files) {
  const written = [];
  try {
    for (const file of files) {
      const stored = await env.FILES.put(file.storageName, file.blob, {
        httpMetadata: { contentType: file.mime },
      });
      if (!stored) throw new Error('R2 put returned no object');
      written.push(file.storageName);
    }
  } catch (error) {
    await cleanupFiles(env, written);
    throw error;
  }
}

async function cleanupFiles(env, names) {
  if (!names.length) return;
  for (let index = 0; index < names.length; index += 1000) {
    try {
      await env.FILES.delete(names.slice(index, index + 1000));
    } catch (error) {
      console.error(JSON.stringify({ operation: 'r2_cleanup', error: String(error) }));
    }
  }
}

async function attachRows(env, materialId, files) {
  if (!files.length) return;
  const statements = files.flatMap((file) => [
    env.DB.prepare('INSERT INTO attachments (material_id, filename, mime, size, storage_name) VALUES (?, ?, ?, ?, ?)')
      .bind(materialId, file.filename, file.mime, file.size, file.storageName),
    env.DB.prepare('INSERT INTO attachment_digests (storage_name, material_id, sha256) VALUES (?, ?, ?)')
      .bind(file.storageName, materialId, file.digest),
  ]);
  await env.DB.batch(statements);
}

async function existingDigests(env, materialId) {
  const rows = await env.DB.prepare(`SELECT a.storage_name, d.sha256 FROM attachments a
    LEFT JOIN attachment_digests d ON d.storage_name = a.storage_name WHERE a.material_id = ?`)
    .bind(materialId).all();
  const hashes = new Set();
  for (const row of rows.results) {
    if (row.sha256) {
      hashes.add(row.sha256);
      continue;
    }
    // Files imported from the local server may predate the digest table.
    const object = await env.FILES.get(row.storage_name);
    if (!object?.body) continue;
    const digest = await sha256Blob(object);
    hashes.add(digest);
    await env.DB.prepare(`INSERT OR IGNORE INTO attachment_digests (storage_name, material_id, sha256)
      VALUES (?, ?, ?)`).bind(row.storage_name, materialId, digest).run();
  }
  return hashes;
}

async function bootstrap(request, env) {
  const [subjects, teachers, materials, attachments, events, admin] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM subjects ORDER BY id').all(),
    env.DB.prepare('SELECT id, subject_id, name FROM teachers ORDER BY id').all(),
    env.DB.prepare(`SELECT m.*, s.name AS subject_name, t.name AS teacher_name FROM materials m
      JOIN subjects s ON s.id = m.subject_id LEFT JOIN teachers t ON t.id = m.teacher_id
      ORDER BY m.created_at DESC, m.id DESC`).all(),
    env.DB.prepare('SELECT id, material_id, filename, mime, size FROM attachments ORDER BY id').all(),
    env.DB.prepare(`SELECT e.*, COALESCE(n.notify_enabled, 1) AS notify_enabled,
      s.name AS subject_name, t.name AS teacher_name FROM events e
      LEFT JOIN event_notification_settings n ON n.event_id = e.id
      LEFT JOIN subjects s ON s.id = e.subject_id LEFT JOIN teachers t ON t.id = e.teacher_id
      ORDER BY e.event_date, e.id`).all(),
    isAdmin(request, env),
  ]);
  const byMaterial = new Map();
  for (const file of attachments.results) {
    if (!byMaterial.has(file.material_id)) byMaterial.set(file.material_id, []);
    byMaterial.get(file.material_id).push(file);
  }
  return json({ admin, subjects: subjects.results, teachers: teachers.results,
    materials: materials.results.map((material) => ({ ...material, attachments: byMaterial.get(material.id) || [] })),
    events: events.results.map((event) => ({ ...event, notify_enabled: Boolean(event.notify_enabled) })) });
}

async function login(request, env) {
  const secret = env.ADMIN_PASSWORD_SHA256;
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/i.test(secret)) {
    fail(503, '관리 비밀번호가 아직 설정되지 않았어요.');
  }
  const client = request.headers.get('CF-Connecting-IP') || 'unknown';
  const clientKey = await sha256(client);
  const now = Math.floor(Date.now() / 1000);
  const attempt = await env.DB.prepare('SELECT window_start, failures FROM login_attempts WHERE client_key = ?')
    .bind(clientKey).first();
  if (attempt && attempt.window_start > now - 300 && attempt.failures >= 8) {
    fail(429, '잠시 후 다시 시도해 주세요.');
  }
  const body = await readJson(request);
  if (typeof body.password !== 'string' || body.password.length > 256) fail(400, '비밀번호를 확인해 주세요.');
  const candidateHash = await sha256(body.password);
  if (!constantTimeHexEqual(candidateHash, secret.toLowerCase())) {
    await env.DB.prepare(`INSERT INTO login_attempts (client_key, window_start, failures) VALUES (?, ?, 1)
      ON CONFLICT(client_key) DO UPDATE SET
      window_start = CASE WHEN window_start > ? THEN window_start ELSE ? END,
      failures = CASE WHEN window_start > ? THEN failures + 1 ELSE 1 END`)
      .bind(clientKey, now, now - 300, now, now - 300).run();
    fail(401, '비밀번호가 맞지 않아요.');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE client_key = ?').bind(clientKey).run();
  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...random)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  await env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)')
    .bind(await sha256(token), now + SESSION_SECONDS).run();
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return json({ admin: true }, 200, {
    'Set-Cookie': `archive_session=${token}; Max-Age=${SESSION_SECONDS}; HttpOnly${secure}; SameSite=Strict; Path=/`,
  });
}

async function logout(request, env) {
  const token = cookieToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return json({ admin: false }, 200, {
    'Set-Cookie': `archive_session=; Max-Age=0; HttpOnly${secure}; SameSite=Strict; Path=/`,
  });
}

async function addSubject(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const name = cleanText(body.name, '과목 이름', 30);
  try {
    const result = await env.DB.prepare('INSERT INTO subjects (name) VALUES (?)').bind(name).run();
    return json({ id: result.meta.last_row_id, name });
  } catch (error) {
    if (String(error).includes('UNIQUE')) fail(409, '이미 있는 과목이에요.');
    throw error;
  }
}

async function addMaterial(request, env) {
  await requireAdmin(request, env);
  const form = await readForm(request);
  const title = cleanText(form.get('title'), '자료 제목', 120);
  const subjectId = integerId(form.get('subject_id'), '과목');
  const teacherId = integerId(form.get('teacher_id'), '선생님', true);
  const kind = form.get('kind');
  if (!KINDS.has(kind)) fail(400, '자료 유형을 확인해 주세요.');
  const note = optionalText(form.get('note'), '설명', 4000);
  const files = await preparedFiles(form);
  if (!files.length && !note) fail(400, '파일 또는 설명을 입력해 주세요.');
  await validateSubjectTeacher(env.DB, subjectId, teacherId);
  const result = await env.DB.prepare(
    'INSERT INTO materials (title, subject_id, teacher_id, kind, note) VALUES (?, ?, ?, ?, ?)'
  ).bind(title, subjectId, teacherId, kind, note).run();
  const materialId = result.meta.last_row_id;
  try {
    await storeFiles(env, files);
    await attachRows(env, materialId, files);
  } catch (error) {
    await cleanupFiles(env, files.map((file) => file.storageName));
    await env.DB.prepare('DELETE FROM materials WHERE id = ?').bind(materialId).run();
    throw error;
  }
  return json({ id: materialId });
}

async function appendFiles(request, env, materialId) {
  await requireAdmin(request, env);
  const material = await env.DB.prepare('SELECT 1 AS valid FROM materials WHERE id = ?').bind(materialId).first();
  if (!material) fail(404, '자료를 찾을 수 없어요.');
  const files = await preparedFiles(await readForm(request));
  if (!files.length) fail(400, '추가할 파일을 선택해 주세요.');
  const hashes = await existingDigests(env, materialId);
  const newFiles = files.filter((file) => {
    if (hashes.has(file.digest)) return false;
    hashes.add(file.digest);
    return true;
  });
  if (!newFiles.length) fail(409, '선택한 파일이 모두 이미 등록되어 있어요.');
  try {
    await storeFiles(env, newFiles);
    await attachRows(env, materialId, newFiles);
  } catch (error) {
    await cleanupFiles(env, newFiles.map((file) => file.storageName));
    if (String(error).includes('UNIQUE')) fail(409, '이미 등록된 파일이에요.');
    throw error;
  }
  return json({ added: newFiles.length });
}

async function deleteMaterial(request, env, materialId) {
  await requireAdmin(request, env);
  const files = await env.DB.prepare('SELECT storage_name FROM attachments WHERE material_id = ?')
    .bind(materialId).all();
  const result = await env.DB.prepare('DELETE FROM materials WHERE id = ?').bind(materialId).run();
  if (!result.meta.changes) fail(404, '자료를 찾을 수 없어요.');
  await cleanupFiles(env, files.results.map((file) => file.storage_name));
  return json({ deleted: true });
}

function contentDisposition(filename, download) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function getFile(request, env, attachmentId) {
  const file = await env.DB.prepare('SELECT filename, mime, size, storage_name FROM attachments WHERE id = ?')
    .bind(attachmentId).first();
  if (!file) fail(404, '파일을 찾을 수 없어요.');
  const object = await env.FILES.get(file.storage_name);
  if (!object?.body) fail(404, '파일을 찾을 수 없어요.');
  const headers = new Headers({
    'Content-Type': file.mime,
    'Content-Length': String(object.size),
    'Content-Disposition': contentDisposition(file.filename, new URL(request.url).searchParams.get('download') === '1'),
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

async function checkedEvent(request, env) {
  const body = await readJson(request);
  const title = cleanText(body.title, '일정 제목', 120);
  const eventDate = validDay(body.event_date);
  if (!EVENT_TYPES.has(body.event_type)) fail(400, '일정 유형을 확인해 주세요.');
  const subjectId = integerId(body.subject_id, '과목', true);
  const teacherId = integerId(body.teacher_id, '선생님', true);
  const description = optionalText(body.description, '설명', 4000);
  if (body.notify_enabled !== undefined && typeof body.notify_enabled !== 'boolean') {
    fail(400, '알림 설정을 확인해 주세요.');
  }
  await validateSubjectTeacher(env.DB, subjectId, teacherId);
  return { values: [title, eventDate, body.event_type, subjectId, teacherId, description],
    notifyEnabled: body.notify_enabled === false ? 0 : 1 };
}

async function addEvent(request, env) {
  await requireAdmin(request, env);
  const { values, notifyEnabled } = await checkedEvent(request, env);
  const result = await env.DB.prepare(`INSERT INTO events
    (title, event_date, event_type, subject_id, teacher_id, description) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(...values).run();
  if (!notifyEnabled) {
    await env.DB.prepare('INSERT INTO event_notification_settings (event_id, notify_enabled) VALUES (?, 0)')
      .bind(result.meta.last_row_id).run();
  }
  return json({ id: result.meta.last_row_id });
}

async function updateEvent(request, env, eventId) {
  await requireAdmin(request, env);
  const { values, notifyEnabled } = await checkedEvent(request, env);
  const result = await env.DB.prepare(`UPDATE events SET title = ?, event_date = ?, event_type = ?,
    subject_id = ?, teacher_id = ?, description = ? WHERE id = ?`)
    .bind(...values, eventId).run();
  if (!result.meta.changes) fail(404, '일정을 찾을 수 없어요.');
  await env.DB.prepare(`INSERT INTO event_notification_settings (event_id, notify_enabled) VALUES (?, ?)
    ON CONFLICT(event_id) DO UPDATE SET notify_enabled = excluded.notify_enabled`)
    .bind(eventId, notifyEnabled).run();
  return json({ updated: true });
}

async function deleteEvent(request, env, eventId) {
  await requireAdmin(request, env);
  const result = await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
  if (!result.meta.changes) fail(404, '일정을 찾을 수 없어요.');
  return json({ deleted: true });
}

async function api(request, env, path) {
  const method = request.method;
  if (!['GET', 'HEAD'].includes(method)) requireSameOrigin(request);
  if (path.startsWith('/api/push/')) {
    const pushResponse = await pushApi(request, env, path);
    if (pushResponse) return pushResponse;
  }
  if (method === 'GET' && path === '/api/bootstrap') return bootstrap(request, env);
  if (method === 'POST' && path === '/api/login') return login(request, env);
  if (method === 'POST' && path === '/api/logout') return logout(request, env);
  if (method === 'POST' && path === '/api/subjects') return addSubject(request, env);
  if (method === 'POST' && path === '/api/materials') return addMaterial(request, env);
  const materialId = routeId(path, /^\/api\/materials\/(\d+)$/);
  if (method === 'DELETE' && materialId !== null) return deleteMaterial(request, env, materialId);
  const appendId = routeId(path, /^\/api\/materials\/(\d+)\/attachments$/);
  if (method === 'POST' && appendId !== null) return appendFiles(request, env, appendId);
  const attachmentId = routeId(path, /^\/api\/files\/(\d+)$/);
  if (['GET', 'HEAD'].includes(method) && attachmentId !== null) return getFile(request, env, attachmentId);
  if (method === 'POST' && path === '/api/events') return addEvent(request, env);
  const eventId = routeId(path, /^\/api\/events\/(\d+)$/);
  if (method === 'PUT' && eventId !== null) return updateEvent(request, env, eventId);
  if (method === 'DELETE' && eventId !== null) return deleteEvent(request, env, eventId);
  fail(404, 'Not found');
}

export default {
  async fetch(request, env) {
    let response;
    const path = new URL(request.url).pathname;
    try {
      if (path.startsWith('/api/')) {
        response = await api(request, env, path);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        response = await env.ASSETS.fetch(request);
        if (response.status === 404 && !path.includes('.')) {
          response = await env.ASSETS.fetch(new URL('/index.html', request.url));
        }
      } else {
        response = json({ detail: 'Not found' }, 404);
      }
    } catch (error) {
      if (error instanceof HttpError) response = json({ detail: error.message }, error.status);
      else {
        console.error(JSON.stringify({ operation: 'request', path, error: String(error) }));
        response = json({ detail: '요청을 처리하지 못했어요.' }, 500);
      }
    }
    const wrapped = new Response(response.body, response);
    wrapped.headers.set('X-Content-Type-Options', 'nosniff');
    wrapped.headers.set('Referrer-Policy', 'same-origin');
    if (path.startsWith('/api/')) wrapped.headers.set('Cache-Control', 'no-store');
    return wrapped;
  },
  async scheduled(controller, env) {
    // Wrangler cron is UTC: 22:00 UTC is 07:00 Asia/Seoul the next day.
    if (controller.cron !== '0 22 * * *') return;
    await sendDueNotifications(env, controller.scheduledTime);
  },
};
