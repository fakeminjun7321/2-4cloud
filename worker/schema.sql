PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(subject_id, name)
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  teacher_id INTEGER REFERENCES teachers(id),
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS attachment_digests (
  storage_name TEXT PRIMARY KEY REFERENCES attachments(storage_name) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(id),
  teacher_id INTEGER REFERENCES teachers(id),
  description TEXT NOT NULL DEFAULT ''
);

-- Separate table keeps this migration idempotent for existing production events.
-- Events without a setting are enabled by default; imported draft school dates
-- should be explicitly disabled.
CREATE TABLE IF NOT EXISTS event_notification_settings (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  notify_enabled INTEGER NOT NULL CHECK (notify_enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  client_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  failures INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_registration_attempts (
  client_key TEXT NOT NULL,
  day TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (client_key, day)
);

CREATE TABLE IF NOT EXISTS push_deliveries (
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  notice_key TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subscription_id, notice_key)
);

CREATE INDEX IF NOT EXISTS attachments_material_id_idx ON attachments(material_id);
CREATE INDEX IF NOT EXISTS materials_created_idx ON materials(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS events_date_idx ON events(event_date, id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS push_deliveries_claimed_idx ON push_deliveries(claimed_at);
CREATE INDEX IF NOT EXISTS push_registration_day_idx ON push_registration_attempts(day);

INSERT OR IGNORE INTO subjects (id, name) VALUES
  (1, '국어'), (2, '영어'), (3, '캘큘'), (4, '확통'),
  (5, '미방'), (6, '일물'), (7, '현물'), (8, '물실'),
  (9, '일화'), (10, '프실'), (11, '일지1'), (12, '일지2');

INSERT OR IGNORE INTO teachers (subject_id, name) VALUES
  (1, '윤소영'),
  (2, '이계화'), (2, '김선옥'),
  (3, '추철우'), (3, '강윤석'), (3, '류상욱'),
  (4, '박진환'), (4, '송석준'),
  (5, '송석준'),
  (6, '김종수'), (6, '박홍'),
  (7, '김제훈'), (7, '조우주'),
  (8, '정재환'),
  (9, '전경희'), (9, '추재석'),
  (10, '박소영'),
  (11, '이윤아'), (11, '배태윤'),
  (12, '채대철');
