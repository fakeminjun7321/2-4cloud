# Cloudflare Worker backend

`index.js` implements the same `/api/*` contract as the local FastAPI server. D1 stores subjects, teachers, materials, events, sessions, and login throttling. R2 stores the original PDF and image bytes. The built Vite frontend is served through `ASSETS`.

## Bindings

- `DB`: D1 database, initialized with `worker/schema.sql`
- `FILES`: private R2 bucket
- `ASSETS`: `dist/` static assets
- `ADMIN_PASSWORD_SHA256`: **Worker secret** containing the lowercase hexadecimal SHA-256 digest of the UTF-8 administrator password. Generate it locally and set it with `wrangler secret put`; do not place the password or digest in source, `wrangler.jsonc`, or the frontend build.
- `VAPID_PUBLIC_KEY`: Worker secret with the base64url-encoded, uncompressed 65-byte P-256 public key. The public value is exposed only through `GET /api/push/public-key` for browser subscription.
- `VAPID_PRIVATE_JWK`: Worker secret with the matching P-256 private JWK JSON (`kty`, `crv`, `x`, `y`, `d`). Generate one key pair and retain the private part outside Git.
- `VAPID_SUBJECT`: optional `mailto:` contact URL or HTTPS URL for the VAPID JWT.
- `NEIS_API_KEY`: optional Worker secret issued by the [NEIS developer portal](https://open.neis.go.kr/portal/guide/apiGuidePage.do). The Worker does not use the undocumented/sample response as its production key.
- `NEIS_EDUCATION_OFFICE_CODE=D10` and `NEIS_SCHOOL_CODE=7240060`: public Wrangler variables for 대구과학고등학교, verified from the official NEIS schoolInfo API.

The secret is a server-side verifier. Login is limited to eight failed attempts per five-minute window per Cloudflare client IP, with attempt state in D1. Sessions use random 256-bit tokens; only their SHA-256 hashes are stored in D1. The cookie is `HttpOnly; SameSite=Strict`, adds `Secure` on HTTPS, and expires after 12 hours. Mutating API requests require a same-origin `Origin` or `Referer` header.

## Schema and migration

Apply `worker/schema.sql` to local and remote D1 before starting the Worker. The migration is idempotent and seeds the 12 specified subjects and their 20 teacher assignments. The schema does **not** migrate existing records or files from the local SQLite/files directory; that is a separate data migration.

The additive tables `event_notification_settings`, `push_subscriptions`, `push_deliveries`, and `push_registration_attempts` must be applied to existing D1 before deploying the updated Worker. The default for an event without a settings row is notifications enabled. Calendar entries imported from the draft academic schedule should have `notify_enabled: false`; ordinary manually entered events default to true.

## API and upload limits

- `GET /api/bootstrap`
- `POST /api/login`, `POST /api/logout`
- `POST /api/subjects`
- `POST /api/materials`, `DELETE /api/materials/:id`
- `POST /api/materials/:id/attachments` to append files
- `GET /api/files/:id` to view, `?download=1` to download
- `POST /api/events`, `PUT /api/events/:id`, `DELETE /api/events/:id`
- `GET /api/push/public-key`, `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions`

An upload accepts up to 24 files, 20 MiB per file, 64 MiB total per request. File extensions and magic bytes must agree for PDF, JPEG, PNG, or WebP. Attachment digests let the append endpoint skip byte-identical files already in the material; older imported attachments are hashed on first append. Upload metadata is committed to D1 only after R2 writes succeed; failed uploads attempt to remove their R2 objects. D1 attachment rows and digests use one batch transaction. Deleting a material removes its D1 records, then its R2 objects.

The source file and seed schema can be syntax-checked without a Cloudflare account. API behavior and persistence still require Wrangler local testing with D1/R2 bindings; production behavior requires a real deployment and user-path verification.

## Push schedule and capacity

`0 22 * * *` runs at **07:00 Asia/Seoul** (Wrangler cron is UTC). One silent Web Push digest per subscribed device combines due reminders for `시험`, `수행평가`, and `제출` entries at 7 days, 1 day, and the day itself, plus the day's NEIS meals when available. `기타` events and entries with `notify_enabled: false` are excluded from reminder delivery. The service worker must set `NotificationOptions.silent: true`; the operating system still controls whether and when a notification appears.

Opt-in stores the browser push endpoint and encryption keys in D1. `push_deliveries` claims each `daily:YYYY-MM-DD` digest for each subscription to avoid duplicate sends. An uncertain network result keeps its claim because the push service may already have accepted it. Explicitly rejected sends release their claim; expired subscriptions (404/410) are deleted. Unsubscribing deletes the endpoint and its delivery records. Registration is capped at **45 devices** globally and **25 new devices per client IP per Korean calendar day**; excess registrations return HTTP 429. This keeps the daily NEIS request plus push requests within the Workers Free 50-external-subrequest limit while allowing a class to enroll from shared school Wi-Fi. Multiple browsers/devices for one student each use a slot. Existing endpoint re-registration and removal require the subscription's `auth` secret.

Without `NEIS_API_KEY`, the scheduled job still sends due calendar reminders and skips the meal section. The official NEIS documentation requires an issued key for live use; a no-key/sample query is not the operational credential. No meal notification is sent on missing data or a NEIS error. The integration sends one meal query for the current Korean calendar day and does not poll.

Generate a VAPID P-256 pair privately. For example, a one-off local Node script can call `crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify'])`, export the public key as `raw`, export the private key as `jwk`, encode the raw public bytes with base64url, then set the two values with `wrangler secret put VAPID_PUBLIC_KEY` and `wrangler secret put VAPID_PRIVATE_JWK`. Do not commit key output, `.dev.vars`, or the NEIS key. Keep the same VAPID pair after deployment so existing browser subscriptions remain valid.

The unit test `node --test worker/push.test.mjs` checks RFC 8291 payload decryption, VAPID signatures, and the Korean date boundary. It does not prove push-service or device delivery; that requires an opted-in physical browser/PWA and a real scheduled run.
