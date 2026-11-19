-- 仁思手札（Rensi Thinking Notebook）Cloudflare D1 資料庫初始化

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  user_json TEXT NOT NULL,
  class_id TEXT,
  seat INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_role ON auth_sessions(role);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_class_seat ON auth_sessions(class_id, seat);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  seats INTEGER NOT NULL,
  require_code INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS class_credentials (
  class_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY (class_id, seat)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  title TEXT NOT NULL,
  class_name TEXT NOT NULL,
  state_json TEXT NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_class ON sessions(class_id, created_at DESC);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  value_json TEXT NOT NULL,
  correct INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_session_act ON answers(session_id, activity_id, seat);

CREATE TABLE IF NOT EXISTS grades (
  answer_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grades_session ON grades(session_id);

CREATE TABLE IF NOT EXISTS learning_records (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  source TEXT NOT NULL,
  slot TEXT,
  item TEXT NOT NULL,
  correct INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_class ON learning_records(class_id, at);

CREATE TABLE IF NOT EXISTS homework (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  class_name TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  title TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS homework_sheets (
  homework_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned',
  sheet_json TEXT NOT NULL,
  submitted_at INTEGER,
  PRIMARY KEY (homework_id, seat)
);
CREATE INDEX IF NOT EXISTS idx_hw_sheets_token ON homework_sheets(homework_id, seat, token);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  homework_id TEXT,
  seat INTEGER,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);
