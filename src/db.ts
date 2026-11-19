import { CATALOG_IDS, CATALOG_LESSONS } from './catalog.generated';
import { hashPassword, randomCode, randomToken } from './crypto';
import { buildAggregate } from './grading';
import type {
  AiSettings,
  Answer,
  Classroom,
  DanmakuItem,
  Env,
  Grade,
  Lesson,
  SessionState,
  User,
} from './types';

export interface TeacherAuth {
  account: string;
  name: string;
  hash: string;
  mustChange: boolean;
}

const DEFAULT_AI: AiSettings = {
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-2.5-flash',
  dailyLimit: 200,
};

let initPromise: Promise<void> | null = null;

export async function ensureInitialized(env: Env): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const existing = await env.DB.prepare(
        'SELECT value FROM settings WHERE key = ?'
      )
        .bind('teacher_auth')
        .first<{ value: string }>();

      if (!existing) {
        const hash = await hashPassword('11235813');
        const auth: TeacherAuth = {
          account: env.DEFAULT_TEACHER_ACCOUNT || 'teacher@rensi.edu',
          name: env.DEFAULT_TEACHER_NAME || '游貿仁老師',
          hash,
          mustChange: true,
        };
        await env.DB.prepare(
          'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
        )
          .bind('teacher_auth', JSON.stringify(auth), Date.now())
          .run();
      }

      const clsCount = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM classes').first<{
        cnt: number;
      }>();
      if ((clsCount?.cnt ?? 0) === 0) {
        const classId = 'cls-demo-801';
        const now = Date.now();
        await env.DB.prepare(
          'INSERT OR IGNORE INTO classes (id, name, code, seats, require_code, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(classId, '801 示範班', 'RENSI801', 30, 0, now)
          .run();
        const stmts: D1PreparedStatement[] = [];
        for (let seat = 1; seat <= 30; seat++) {
          stmts.push(
            env.DB.prepare(
              'INSERT OR IGNORE INTO class_credentials (class_id, seat, code) VALUES (?, ?, ?)'
            ).bind(classId, seat, `R${String(seat).padStart(2, '0')}${randomCode(3)}`)
          );
        }
        await env.DB.batch(stmts);
      }
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export async function getSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function setSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

export async function getTeacherAuth(env: Env): Promise<TeacherAuth> {
  await ensureInitialized(env);
  const auth = await getSetting<TeacherAuth>(env.DB, 'teacher_auth');
  if (!auth) throw new Error('教師帳號資料未初始化');
  return auth;
}

export async function getEffectiveAiConfig(env: Env): Promise<{
  provider: AiSettings['provider'];
  baseUrl: string;
  model: string;
  apiKey: string;
  dailyLimit: number;
  configured: boolean;
  source: 'env' | 'teacher' | 'none';
  keyHint: string;
}> {
  const saved = await getSetting<AiSettings>(env.DB, 'ai_settings');
  if (saved?.apiKey) {
    return {
      provider: saved.provider || DEFAULT_AI.provider,
      baseUrl: saved.baseUrl || DEFAULT_AI.baseUrl,
      model: saved.model || DEFAULT_AI.model,
      apiKey: saved.apiKey,
      dailyLimit: saved.dailyLimit || 200,
      configured: true,
      source: 'teacher',
      keyHint: `••••${saved.apiKey.slice(-4)}`,
    };
  }
  if (env.AI_API_KEY) {
    return {
      provider: (env.AI_PROVIDER as AiSettings['provider']) || 'gemini',
      baseUrl: env.AI_BASE_URL || DEFAULT_AI.baseUrl,
      model: env.AI_MODEL || DEFAULT_AI.model,
      apiKey: env.AI_API_KEY,
      dailyLimit: saved?.dailyLimit || 200,
      configured: true,
      source: 'env',
      keyHint: `••••${env.AI_API_KEY.slice(-4)}`,
    };
  }
  return {
    provider: saved?.provider || DEFAULT_AI.provider,
    baseUrl: saved?.baseUrl || DEFAULT_AI.baseUrl,
    model: saved?.model || DEFAULT_AI.model,
    apiKey: '',
    dailyLimit: saved?.dailyLimit || 200,
    configured: false,
    source: 'none',
    keyHint: '',
  };
}

export async function listLessons(db: D1Database): Promise<Lesson[]> {
  const { results } = await db
    .prepare('SELECT id, data_json FROM lessons ORDER BY updated_at DESC')
    .all<{ id: string; data_json: string }>();
  const map = new Map<string, Lesson>();
  for (const cat of CATALOG_LESSONS) {
    map.set(cat.id, cat);
  }
  for (const row of results) {
    try {
      const parsed = JSON.parse(row.data_json) as Lesson;
      map.set(row.id, parsed);
    } catch {
      // ignore malformed
    }
  }
  return [...map.values()];
}

export async function getLessonById(db: D1Database, id: string): Promise<Lesson | null> {
  const row = await db
    .prepare('SELECT data_json FROM lessons WHERE id = ?')
    .bind(id)
    .first<{ data_json: string }>();
  if (row) {
    try {
      return JSON.parse(row.data_json) as Lesson;
    } catch {
      return null;
    }
  }
  return CATALOG_LESSONS.find((l) => l.id === id) ?? null;
}

export async function saveLesson(db: D1Database, lesson: Lesson): Promise<Lesson> {
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO lessons (id, title, subject, data_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, subject = excluded.subject, data_json = excluded.data_json, updated_at = excluded.updated_at'
    )
    .bind(lesson.id, lesson.title, lesson.subject || '跨科探究', JSON.stringify(lesson), now)
    .run();
  return lesson;
}

export async function listClasses(db: D1Database): Promise<Classroom[]> {
  const { results } = await db
    .prepare('SELECT id, name, code, seats, require_code, created_at FROM classes ORDER BY created_at DESC')
    .all<{
      id: string;
      name: string;
      code: string;
      seats: number;
      require_code: number;
      created_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    seats: r.seats,
    requireCode: Boolean(r.require_code),
    createdAt: r.created_at,
  }));
}

export async function getClassById(db: D1Database, id: string): Promise<Classroom | null> {
  const r = await db
    .prepare('SELECT id, name, code, seats, require_code, created_at FROM classes WHERE id = ?')
    .bind(id)
    .first<{
      id: string;
      name: string;
      code: string;
      seats: number;
      require_code: number;
      created_at: number;
    }>();
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    seats: r.seats,
    requireCode: Boolean(r.require_code),
    createdAt: r.created_at,
  };
}

export async function getClassByCode(db: D1Database, code: string): Promise<Classroom | null> {
  const r = await db
    .prepare('SELECT id, name, code, seats, require_code, created_at FROM classes WHERE UPPER(code) = UPPER(?)')
    .bind(code.trim())
    .first<{
      id: string;
      name: string;
      code: string;
      seats: number;
      require_code: number;
      created_at: number;
    }>();
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    seats: r.seats,
    requireCode: Boolean(r.require_code),
    createdAt: r.created_at,
  };
}

export async function createClass(
  db: D1Database,
  name: string,
  seats: number
): Promise<{ classroom: Classroom; credentials: Array<{ seat: number; code: string }> }> {
  const id = `cls-${crypto.randomUUID().slice(0, 8)}`;
  const code = randomCode(6);
  const now = Date.now();
  await db
    .prepare('INSERT INTO classes (id, name, code, seats, require_code, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .bind(id, name.trim(), code, seats, now)
    .run();

  const credentials: Array<{ seat: number; code: string }> = [];
  const stmts: D1PreparedStatement[] = [];
  for (let seat = 1; seat <= seats; seat++) {
    const sc = randomCode(5);
    credentials.push({ seat, code: sc });
    stmts.push(
      db.prepare('INSERT INTO class_credentials (class_id, seat, code) VALUES (?, ?, ?)').bind(id, seat, sc)
    );
  }
  await db.batch(stmts);
  return {
    classroom: { id, name: name.trim(), code, seats, requireCode: true, createdAt: now },
    credentials,
  };
}

export async function createAuthSession(db: D1Database, user: User): Promise<string> {
  const token = randomToken(24);
  const now = Date.now();
  const expires = now + 1000 * 60 * 60 * 24 * 14;
  await db
    .prepare(
      'INSERT INTO auth_sessions (token, role, user_json, class_id, seat, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      token,
      user.role,
      JSON.stringify(user),
      user.classId ?? null,
      user.seat ?? null,
      now,
      expires
    )
    .run();
  return token;
}

export async function getAuthSession(db: D1Database, token: string): Promise<User | null> {
  const row = await db
    .prepare('SELECT user_json, expires_at FROM auth_sessions WHERE token = ?')
    .bind(token)
    .first<{ user_json: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run();
    return null;
  }
  try {
    return JSON.parse(row.user_json) as User;
  } catch {
    return null;
  }
}

export async function listSessionsSummary(db: D1Database): Promise<
  Array<{
    id: string;
    classId: string;
    lessonId: string;
    title: string;
    className: string;
    ended: boolean;
    createdAt: number;
  }>
> {
  const { results } = await db
    .prepare('SELECT id, class_id, lesson_id, title, class_name, ended, created_at FROM sessions ORDER BY created_at DESC LIMIT 200')
    .all<{
      id: string;
      class_id: string;
      lesson_id: string;
      title: string;
      class_name: string;
      ended: number;
      created_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    classId: r.class_id,
    lessonId: r.lesson_id,
    title: r.title,
    className: r.class_name,
    ended: Boolean(r.ended),
    createdAt: r.created_at,
  }));
}

export async function getSessionRow(db: D1Database, id: string): Promise<{
  state: SessionState;
  danmaku: DanmakuItem[];
} | null> {
  const row = await db
    .prepare('SELECT state_json FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ state_json: string }>();
  if (!row) return null;
  const parsed = JSON.parse(row.state_json) as SessionState & { danmaku?: DanmakuItem[] };
  const danmaku = parsed.danmaku ?? [];
  return { state: parsed, danmaku };
}

export async function saveSessionRow(
  db: D1Database,
  state: SessionState,
  danmaku: DanmakuItem[]
): Promise<void> {
  state.revision = (state.revision || 0) + 1;
  state.updatedAt = Date.now();
  const payload = { ...state, danmaku: danmaku.slice(-100) };
  await db
    .prepare('UPDATE sessions SET state_json = ?, ended = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(payload), state.ended ? 1 : 0, state.updatedAt, state.id)
    .run();
}

export async function getSessionAnswers(db: D1Database, sessionId: string): Promise<Answer[]> {
  const { results } = await db
    .prepare(
      'SELECT id, session_id, activity_id, seat, attempt, value_json, correct, created_at FROM answers WHERE session_id = ? ORDER BY created_at ASC'
    )
    .bind(sessionId)
    .all<{
      id: string;
      session_id: string;
      activity_id: string;
      seat: number;
      attempt: number;
      value_json: string;
      correct: number | null;
      created_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    activityId: r.activity_id,
    seat: r.seat,
    attempt: r.attempt,
    value: JSON.parse(r.value_json),
    correct: r.correct === null ? null : Boolean(r.correct),
    createdAt: r.created_at,
  }));
}

export async function getSessionGrades(db: D1Database, sessionId: string): Promise<Grade[]> {
  const { results } = await db
    .prepare('SELECT data_json FROM grades WHERE session_id = ?')
    .bind(sessionId)
    .all<{ data_json: string }>();
  return results.map((r) => JSON.parse(r.data_json) as Grade);
}

export async function getOnlineSeats(env: Env, classId: string): Promise<number[]> {
  try {
    const id = env.CLASSROOM_HUB.idFromName('global-hub');
    const stub = env.CLASSROOM_HUB.get(id);
    const res = await stub.fetch(`https://hub.internal/online?classId=${encodeURIComponent(classId)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { seats?: number[] };
    return data.seats ?? [];
  } catch {
    return [];
  }
}

export async function buildSessionView(
  env: Env,
  sessionId: string,
  viewerRole: 'teacher' | 'student',
  viewerSeat?: number
): Promise<Record<string, unknown> | null> {
  const row = await getSessionRow(env.DB, sessionId);
  if (!row) return null;
  const { state, danmaku } = row;
  const lesson = await getLessonById(env.DB, state.lessonId);
  if (!lesson) return null;

  const classroom = await getClassById(env.DB, state.classId);
  const totalSeats = classroom?.seats ?? 30;
  const onlineList = await getOnlineSeats(env, state.classId);
  const onlineSet = new Set<number>(onlineList);
  if (viewerRole === 'student' && viewerSeat) onlineSet.add(viewerSeat);

  const allAnswers = await getSessionAnswers(env.DB, sessionId);
  const allGrades = await getSessionGrades(env.DB, sessionId);
  const slide = lesson.slides[state.slideIndex] ?? lesson.slides[0];
  const activity = slide?.activity;

  const latestBySeat = new Map<number, Answer>();
  if (activity) {
    for (const a of allAnswers) {
      if (a.activityId === activity.id) {
        latestBySeat.set(a.seat, a);
      }
    }
  }
  const latestAnswers = [...latestBySeat.values()];

  const roster = Array.from({ length: totalSeats }, (_, i) => {
    const seat = i + 1;
    return {
      seat,
      online: onlineSet.has(seat),
      answered: latestBySeat.has(seat),
    };
  });

  const aggregate = buildAggregate(activity, latestAnswers, totalSeats);

  // Filter answers/grades for student privacy and attach userId expected by client Df()
  const answersWithUser = allAnswers.map((a) => ({
    ...a,
    userId: `stu-${state.classId}-${a.seat}`,
  }));
  const visibleAnswers =
    viewerRole === 'teacher'
      ? answersWithUser
      : answersWithUser.filter((a) => a.seat === viewerSeat);
  const visibleGrades =
    viewerRole === 'teacher'
      ? allGrades
      : allGrades.filter((g) => g.seat === viewerSeat && g.released);

  // Raid map wins for this class & lesson
  const raidWins = (await getSetting<Record<string, unknown>>(
    env.DB,
    `raid_wins:${state.classId}:${state.lessonId}`
  )) ?? { wins: {} };

  // Build quiz view if active
  let quizView: Record<string, unknown> | null = null;
  if (state.quiz) {
    const qState = state.quiz as Record<string, unknown>;
    if (viewerRole === 'teacher') {
      quizView = qState;
    } else {
      const seatKey = String(viewerSeat ?? 0);
      const scores = (qState.scores as Record<string, unknown>) || {};
      const myProgress = (qState.playerProgress as Record<string, unknown>)?.[seatKey] ?? null;
      quizView = {
        run: qState.run,
        questions: qState.questions,
        scores,
        mine: myProgress,
        prev: qState.prev,
        bot: qState.bot,
      };
    }
  }

  // Build raid view if active
  let raidView: Record<string, unknown> | null = null;
  if (state.raid) {
    const rState = state.raid as Record<string, unknown>;
    if (viewerRole === 'teacher') {
      raidView = rState;
    } else {
      const seatKey = String(viewerSeat ?? 0);
      const players = (rState.players as Record<string, unknown>) || {};
      raidView = {
        ...rState,
        mine: players[seatKey] ?? null,
      };
    }
  }

  // Build duel view if active
  let duelView: Record<string, unknown> | null = null;
  if (state.duel) {
    const dState = state.duel as Record<string, unknown>;
    if (viewerRole === 'teacher') {
      duelView = dState;
    } else {
      const seatKey = String(viewerSeat ?? 0);
      const players = (dState.players as Record<string, unknown>) || {};
      duelView = {
        ...dState,
        mine: players[seatKey] ?? null,
      };
    }
  }

  // Practice filtering for student
  const practiceView =
    state.practice && viewerRole === 'student'
      ? {
          ...state.practice,
          entries: state.practice.entries.filter((e) => e.seat === viewerSeat),
        }
      : state.practice;

  const danmakuQuota =
    viewerRole === 'student' && activity
      ? {
          limited: true,
          eligible: latestBySeat.get(viewerSeat ?? 0)?.correct === true,
          left: Math.max(
            0,
            3 -
              danmaku.filter(
                (d) => d.seat === viewerSeat && d.at >= state.danmakuClearedAt
              ).length
          ),
        }
      : undefined;

  return {
    serverNow: Date.now(),
    session: {
      ...state,
      quiz: state.quiz ? { id: (state.quiz as { run?: { id?: string } }).run?.id, endedAt: (state.quiz as { run?: { endedAt?: number } }).run?.endedAt } : null,
      raid: state.raid ? { id: (state.raid as { run?: { id?: string } }).run?.id, endedAt: (state.raid as { run?: { endedAt?: number } }).run?.endedAt } : null,
      duel: state.duel ? { id: (state.duel as { run?: { id?: string } }).run?.id, endedAt: (state.duel as { run?: { endedAt?: number } }).run?.endedAt } : null,
    },
    lesson,
    roster,
    answers: visibleAnswers,
    grades: visibleGrades,
    aggregate,
    danmaku,
    whiteboard: state.whiteboard || {},
    practice: practiceView,
    quiz: quizView,
    raid: raidView,
    raidMap: lesson.raid
      ? {
          section: lesson.raid.section || '',
          title: lesson.raid.title,
          wins: (raidWins as { wins?: Record<string, unknown> }).wins ?? {},
        }
      : null,
    duel: duelView,
    ...(danmakuQuota ? { danmakuQuota } : {}),
  };
}

export async function broadcastSessionUpdate(env: Env, sessionId: string): Promise<void> {
  try {
    const teacherView = await buildSessionView(env, sessionId, 'teacher');
    if (!teacherView) return;
    const row = await getSessionRow(env.DB, sessionId);
    if (!row) return;
    const classId = row.state.classId;
    const classroom = await getClassById(env.DB, classId);
    const totalSeats = classroom?.seats ?? 30;
    const onlineSeats = await getOnlineSeats(env, classId);

    const studentViews: Record<string, unknown> = {};
    for (const seat of onlineSeats) {
      if (seat >= 1 && seat <= totalSeats) {
        studentViews[String(seat)] = await buildSessionView(env, sessionId, 'student', seat);
      }
    }

    const id = env.CLASSROOM_HUB.idFromName('global-hub');
    const stub = env.CLASSROOM_HUB.get(id);
    await stub.fetch('https://hub.internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        classId,
        teacherView,
        studentViews,
      }),
    });
  } catch {
    // Non-fatal; polling backup keeps clients synchronized
  }
}

export async function recordLearningEvent(
  db: D1Database,
  params: {
    classId: string;
    lessonId: string;
    sessionId: string;
    seat: number;
    source: string;
    slot?: string;
    item: string;
    correct: boolean;
  }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO learning_records (id, class_id, lesson_id, session_id, seat, source, slot, item, correct, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      `lr-${crypto.randomUUID().slice(0, 12)}`,
      params.classId,
      params.lessonId,
      params.sessionId,
      params.seat,
      params.source,
      params.slot ?? null,
      params.item,
      params.correct ? 1 : 0,
      Date.now()
    )
    .run();
}

export { CATALOG_IDS };
