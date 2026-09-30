// Web Push: RFC 8291 (aes128gcm), RFC 8292 (VAPID), RFC 8188 (record framing).
// VAPID_PRIVATE_JWK and NEIS_API_KEY are Worker secrets, never client assets.
const textEncoder = new TextEncoder();
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_API_JSON_BYTES = 4096;
const MAX_NEIS_BYTES = 128 * 1024;
// Workers Free allows 50 external subrequests per scheduled invocation.
// One NEIS request + at most 45 push requests leaves room below that limit.
const MAX_SUBSCRIPTIONS = 45;
// A classroom may enroll from one shared school Wi-Fi IP on the same day.
const MAX_NEW_SUBSCRIPTIONS_PER_IP_DAY = 25;
const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
]);

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function encode64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode64(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('invalid key');
  const unpadded = value.replace(/=+$/, '');
  const binary = atob(unpadded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - unpadded.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (expectedLength && bytes.length !== expectedLength) throw new Error('invalid key length');
  return bytes;
}

function authKeyMatches(left, right) {
  try {
    const leftBytes = decode64(left, 16);
    const rightBytes = decode64(right, 16);
    let difference = 0;
    for (let index = 0; index < 16; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
    return difference === 0;
  } catch {
    return false;
  }
}

async function clientKey(request) {
  // Cloudflare supplies this header at the edge. Never trust X-Forwarded-For.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(ip)));
  return encode64(digest);
}

function response(value, status = 200) {
  return Response.json(value, { status });
}

function pushConfigured(env) {
  try {
    const key = decode64(env.VAPID_PUBLIC_KEY, 65);
    const privateKey = JSON.parse(env.VAPID_PRIVATE_JWK);
    return key[0] === 4 && privateKey.kty === 'EC' && privateKey.crv === 'P-256'
      && encode64(concat(Uint8Array.of(4), decode64(privateKey.x, 32), decode64(privateKey.y, 32))) === env.VAPID_PUBLIC_KEY
      && decode64(privateKey.d, 32).length === 32;
  } catch {
    return false;
  }
}

function validPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && url.port === '' && (PUSH_HOSTS.has(url.hostname)
        || url.hostname.endsWith('.notify.windows.com'));
  } catch {
    return false;
  }
}

async function readSmallJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return null;
  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_API_JSON_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let count = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > MAX_API_JSON_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(concat(...chunks)));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function pushApi(request, env, path) {
  if (request.method === 'GET' && path === '/api/push/public-key') {
    return response({ enabled: pushConfigured(env), publicKey: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : null,
      mealEnabled: Boolean(env.NEIS_API_KEY) });
  }
  if (path !== '/api/push/subscriptions') return null;
  if (!pushConfigured(env)) return response({ detail: '알림 서비스가 아직 설정되지 않았어요.' }, 503);
  const body = await readSmallJson(request);
  if (!body) return response({ detail: '요청 내용을 확인해 주세요.' }, 400);
  if (request.method === 'POST') {
    const subscription = body.subscription;
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    try {
      if (!validPushEndpoint(endpoint) || decode64(p256dh, 65)[0] !== 4 || !decode64(auth, 16)) {
        throw new Error('invalid subscription');
      }
      // Reject off-curve points instead of storing subscriptions that can never be encrypted.
      await crypto.subtle.importKey('raw', decode64(p256dh, 65), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    } catch {
      return response({ detail: '브라우저 알림 구독을 확인해 주세요.' }, 400);
    }
    const existing = await env.DB.prepare('SELECT id, auth FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first();
    if (existing) {
      if (!authKeyMatches(existing.auth, auth)) {
        return response({ detail: '이 기기의 알림 구독을 확인할 수 없어요.' }, 403);
      }
      await env.DB.prepare('UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE id = ?')
        .bind(p256dh, auth, existing.id).run();
    } else {
      const key = await clientKey(request);
      if (!key) return response({ detail: '접속 정보를 확인할 수 없어 알림 구독을 등록하지 못했어요.' }, 503);
      const day = koreaDate(Date.now());
      const attempt = await env.DB.prepare(`INSERT INTO push_registration_attempts (client_key, day, attempts)
        VALUES (?, ?, 1) ON CONFLICT(client_key, day) DO UPDATE SET attempts = attempts + 1
        WHERE attempts < ?`).bind(key, day, MAX_NEW_SUBSCRIPTIONS_PER_IP_DAY).run();
      if (!attempt.meta.changes) {
        return response({ detail: '하루에 새로 등록할 수 있는 알림 기기 수를 초과했어요. 내일 다시 시도해 주세요.' }, 429);
      }
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO push_subscriptions (endpoint, p256dh, auth)
        SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM push_subscriptions) < ?`)
        .bind(endpoint, p256dh, auth, MAX_SUBSCRIPTIONS).run();
      if (!inserted.meta.changes) {
        const concurrent = await env.DB.prepare('SELECT id, auth FROM push_subscriptions WHERE endpoint = ?')
          .bind(endpoint).first();
        if (concurrent && !authKeyMatches(concurrent.auth, auth)) {
          return response({ detail: '이 기기의 알림 구독을 확인할 수 없어요.' }, 403);
        }
        if (!concurrent) {
          return response({ detail: '알림을 받을 수 있는 기기 수가 가득 찼어요. 관리자에게 알려 주세요.' }, 429);
        }
      }
    }
    return response({ subscribed: true });
  }
  if (request.method === 'DELETE') {
    if (!validPushEndpoint(body.endpoint) || !body.auth) {
      return response({ detail: '알림 구독을 확인해 주세요.' }, 400);
    }
    const existing = await env.DB.prepare('SELECT auth FROM push_subscriptions WHERE endpoint = ?')
      .bind(body.endpoint).first();
    if (!existing) return response({ subscribed: false });
    if (!authKeyMatches(existing.auth, body.auth)) {
      return response({ detail: '이 기기의 알림 구독을 확인할 수 없어요.' }, 403);
    }
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
    return response({ subscribed: false });
  }
  return response({ detail: 'Not found' }, 404);
}

async function encryptedPayload(subscription, data) {
  const userPublic = decode64(subscription.p256dh, 65);
  const authSecret = decode64(subscription.auth, 16);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const receiverKey = await crypto.subtle.importKey('raw', userPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, ephemeral.privateKey, 256);
  const keyInfo = concat(textEncoder.encode('WebPush: info\0'), userPublic, senderPublic);
  const sharedKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const ikm = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo }, sharedKey, 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt,
    info: textEncoder.encode('Content-Encoding: aes128gcm\0') }, ikmKey, 128);
  const nonce = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt,
    info: textEncoder.encode('Content-Encoding: nonce\0') }, ikmKey, 96);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concat(textEncoder.encode(JSON.stringify(data)), Uint8Array.of(2));
  const recordSize = 4096;
  if (plaintext.length + 16 >= recordSize) throw new Error('push payload is too large');
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = senderPublic.length;
  return concat(header, senderPublic, ciphertext);
}

async function vapidToken(env, endpoint) {
  const url = new URL(endpoint);
  const header = encode64(textEncoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const subject = env.VAPID_SUBJECT || 'https://2-4.cloud';
  if (typeof subject !== 'string' || !/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error('invalid VAPID subject');
  }
  const claims = { aud: url.origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject };
  const body = encode64(textEncoder.encode(JSON.stringify(claims)));
  const input = `${header}.${body}`;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, textEncoder.encode(input)));
  return `${input}.${encode64(signature)}`;
}

async function sendPush(env, subscription, data, tokenCache) {
  let body;
  let token;
  try {
    body = await encryptedPayload(subscription, data);
    const origin = new URL(subscription.endpoint).origin;
    token = tokenCache.get(origin);
    if (!token) {
      token = await vapidToken(env, subscription.endpoint);
      tokenCache.set(origin, token);
    }
  } catch (error) {
    const preparationError = new Error(`push preparation failed: ${String(error)}`);
    preparationError.preparationFailed = true;
    throw preparationError;
  }
  const result = await fetch(subscription.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Authorization': `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'normal',
    },
    body,
  });
  return result.status;
}

function koreaDate(epochMs) {
  return new Date(epochMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function dueEventNotice(events) {
  if (!events.length) return null;
  const lines = events.map((event) => {
    const lead = event.days_until === 7 ? '1주 전' : event.days_until === 1 ? '하루 전' : '오늘';
    return `${lead} · ${event.title}`;
  });
  const body = lines.join('\n').slice(0, 380);
  return { title: '2-4 cloud · 일정 알림', body, url: '/calendar', tag: 'calendar-today', silent: true };
}

const MEAL_NAMES = { '1': '아침', '2': '점심', '3': '저녁' };

function emptyMeals() {
  return Object.entries(MEAL_NAMES).map(([code, name]) => ({
    code, name, available: false, dishes: [], calories: null,
  }));
}

function cleanDish(value) {
  return String(value).replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/^\s*\*/, '').replace(/\s+/g, ' ').trim();
}

async function fetchNeisMealRows(env, day) {
  const url = new URL('https://open.neis.go.kr/hub/mealServiceDietInfo');
  url.search = new URLSearchParams({
    KEY: env.NEIS_API_KEY, Type: 'json', pIndex: '1', pSize: '20',
    ATPT_OFCDC_SC_CODE: env.NEIS_EDUCATION_OFFICE_CODE,
    SD_SCHUL_CODE: env.NEIS_SCHOOL_CODE,
    MLSV_YMD: day.replaceAll('-', ''),
  }).toString();
  const result = await fetch(url, { redirect: 'error' });
  if (!result.ok) {
    const error = new Error(`NEIS HTTP ${result.status}`);
    if (result.status === 429 || result.status === 401 || result.status === 403) error.cooldownSeconds = 86400;
    throw error;
  }
  const declared = Number(result.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_NEIS_BYTES) throw new Error('NEIS response too large');
  const reader = result.body?.getReader();
  if (!reader) throw new Error('NEIS response empty');
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_NEIS_BYTES) {
      await reader.cancel();
      throw new Error('NEIS response too large');
    }
    chunks.push(value);
  }
  const value = JSON.parse(new TextDecoder().decode(concat(...chunks)));
  const rows = value.mealServiceDietInfo?.[1]?.row;
  if (!Array.isArray(rows)) {
    const code = value.RESULT?.CODE || value.mealServiceDietInfo?.[0]?.head?.find((part) => part.RESULT)?.RESULT?.CODE;
    if (code === 'INFO-200') return [];
    const error = new Error(`NEIS result ${code || 'unexpected format'}`);
    if (code) error.cooldownSeconds = 86400;
    throw error;
  }
  return rows.filter((row) => row.MLSV_YMD === day.replaceAll('-', '')
    && row.ATPT_OFCDC_SC_CODE === env.NEIS_EDUCATION_OFFICE_CODE
    && row.SD_SCHUL_CODE === env.NEIS_SCHOOL_CODE);
}

function structuredMeals(rows) {
  const byCode = new Map(rows.map((row) => [String(row.MMEAL_SC_CODE), row]));
  return emptyMeals().map((meal) => {
    const row = byCode.get(meal.code);
    if (!row) return meal;
    const dishes = String(row.DDISH_NM || '').split(/<br\s*\/?>/i).map(cleanDish).filter(Boolean);
    return { ...meal, available: dishes.length > 0, dishes,
      calories: typeof row.CAL_INFO === 'string' && row.CAL_INFO.trim() ? row.CAL_INFO.trim() : null };
  });
}

export async function getMealsForDay(env, day) {
  const base = { date: day, source: 'NEIS', meals: emptyMeals(), fetchedAt: null };
  if (!env.NEIS_API_KEY || !env.NEIS_EDUCATION_OFFICE_CODE || !env.NEIS_SCHOOL_CODE) {
    return { ...base, status: 'unconfigured', detail: '급식 정보 연결을 준비하고 있어요.' };
  }
  const now = Math.floor(Date.now() / 1000);
  const cached = await env.DB.prepare('SELECT payload_json, expires_at FROM neis_meal_cache WHERE day = ?')
    .bind(day).first();
  if (cached?.payload_json && cached.expires_at > now) return JSON.parse(cached.payload_json);
  const lease = await env.DB.prepare(`INSERT INTO neis_meal_cache (day, lease_until) VALUES (?, ?)
    ON CONFLICT(day) DO UPDATE SET lease_until = excluded.lease_until
    WHERE neis_meal_cache.expires_at <= ? AND neis_meal_cache.lease_until <= ?`)
    .bind(day, now + 30, now, now).run();
  if (!lease.meta.changes) {
    if (cached?.payload_json) return JSON.parse(cached.payload_json);
    return { ...base, status: 'error', detail: '급식 정보를 조회하고 있어요. 잠시 후 다시 확인해 주세요.' };
  }
  let payload;
  let ttl;
  try {
    const rows = await fetchNeisMealRows(env, day);
    const meals = structuredMeals(rows);
    const hasMeal = meals.some((meal) => meal.available);
    payload = { ...base, meals, status: hasMeal ? 'ok' : 'no_meal', fetchedAt: new Date().toISOString() };
    ttl = hasMeal ? 3600 : 1800;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const diagnostic = /^NEIS (HTTP \d{3}|result [A-Za-z0-9_-]+|response too large|response empty)$/.test(message)
      ? message : 'provider_request_failed';
    console.error(JSON.stringify({ operation: 'neis_meal_read', diagnostic }));
    payload = { ...base, status: 'error', fetchedAt: new Date().toISOString(),
      detail: '급식 정보를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.' };
    ttl = error.cooldownSeconds || 300;
  }
  await env.DB.prepare(`UPDATE neis_meal_cache SET payload_json = ?, expires_at = ?, lease_until = 0
    WHERE day = ?`).bind(JSON.stringify(payload), now + ttl, day).run();
  return payload;
}

export async function mealsApi(request, env, path) {
  if (path !== '/api/meals/today') return null;
  if (request.method !== 'GET' || new URL(request.url).search) {
    return response({ detail: 'Not found' }, 404);
  }
  const payload = await getMealsForDay(env, koreaDate(Date.now()));
  return response(payload, payload.status === 'unconfigured' ? 503 : payload.status === 'error' ? 502 : 200);
}

async function fetchNeisMeals(env, day) {
  const result = await getMealsForDay(env, day);
  if (result.status !== 'ok') return null;
  const body = result.meals.filter((meal) => meal.available)
    .map((meal) => `${meal.name}: ${meal.dishes.join(', ')}`).join('\n');
  return body ? { title: `오늘 급식 · ${day}`, body: body.slice(0, 380),
    url: '/meals', tag: `meal-${day}`, silent: true } : null;
}

async function deliverOnce(env, subscription, key, payload, tokenCache) {
  const claim = await env.DB.prepare(`INSERT OR IGNORE INTO push_deliveries (subscription_id, notice_key)
    VALUES (?, ?)`).bind(subscription.id, key).run();
  if (!claim.meta.changes) return;
  try {
    const status = await sendPush(env, subscription, payload, tokenCache);
    if (status === 404 || status === 410) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(subscription.id).run();
      return;
    }
    if (status < 200 || status >= 300) {
      await env.DB.prepare('DELETE FROM push_deliveries WHERE subscription_id = ? AND notice_key = ?')
        .bind(subscription.id, key).run();
      console.warn(JSON.stringify({ operation: 'push_rejected', status }));
    }
  } catch (error) {
    if (error.preparationFailed) {
      await env.DB.prepare('DELETE FROM push_deliveries WHERE subscription_id = ? AND notice_key = ?')
        .bind(subscription.id, key).run();
      console.error(JSON.stringify({ operation: 'push_preparation_failed', error: String(error) }));
      return;
    }
    // Delivery may have reached the push service before a network failure. Retain the
    // claim to prevent a duplicate; report the uncertain result for investigation.
    console.error(JSON.stringify({ operation: 'push_uncertain', error: String(error) }));
  }
}

export async function sendDueNotifications(env, scheduledTime = Date.now()) {
  await env.DB.prepare('DELETE FROM push_registration_attempts WHERE day < ?')
    .bind(addDays(koreaDate(scheduledTime), -7)).run();
  if (!pushConfigured(env)) {
    console.info(JSON.stringify({ operation: 'notifications_skipped', reason: 'vapid_unconfigured' }));
    return;
  }
  const subscriptions = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id').all();
  if (!subscriptions.results.length) return;
  const day = koreaDate(scheduledTime);
  const targetDays = [0, 1, 7].map((offset) => addDays(day, offset));
  const due = await env.DB.prepare(`SELECT e.id, e.title, e.event_date, e.event_type FROM events e
    LEFT JOIN event_notification_settings n ON n.event_id = e.id
    WHERE e.event_type IN ('시험', '수행평가', '제출') AND COALESCE(n.notify_enabled, 1) = 1
      AND e.event_date IN (?, ?, ?)
    ORDER BY e.event_date, e.id`).bind(...targetDays).all();
  const events = due.results.map((event) => ({ ...event,
    days_until: targetDays.indexOf(event.event_date) === 0 ? 0
      : targetDays.indexOf(event.event_date) === 1 ? 1 : 7 }));
  const eventNotice = dueEventNotice(events);
  let mealNotice = null;
  try {
    mealNotice = await fetchNeisMeals(env, day);
  } catch (error) {
    console.error(JSON.stringify({ operation: 'neis_meal', error: String(error) }));
  }
  if (!eventNotice && !mealNotice) return;
  const notice = eventNotice && mealNotice ? {
    title: '2-4 cloud · 오늘의 알림',
    body: `${eventNotice.body.slice(0, 180)}\n\n${mealNotice.body.slice(0, 180)}`,
    url: '/calendar', tag: `daily-${day}`, silent: true,
  } : eventNotice || mealNotice;
  const tokenCache = new Map();
  for (const subscription of subscriptions.results) {
    await deliverOnce(env, subscription, `daily:${day}`, notice, tokenCache);
  }
}

// Exposed for local protocol and scheduler tests; not routed to HTTP clients.
export const testHelpers = { encryptedPayload, vapidToken, koreaDate, addDays, dueEventNotice, fetchNeisMeals };
