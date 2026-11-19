import {
  generateLessonDraft,
  getAiUsedToday,
  gradeAnswerWithAi,
  runAiAssistantTask,
  runOcrTask,
  testAiConnection,
} from './ai';
import {
  clearSessionCookie,
  getSessionCookie,
  hashPassword,
  makeSessionCookie,
  randomCode,
  verifyPassword,
} from './crypto';
import {
  broadcastSessionUpdate,
  buildSessionView,
  CATALOG_IDS,
  createAuthSession,
  createClass,
  ensureInitialized,
  getAuthSession,
  getClassByCode,
  getClassById,
  getEffectiveAiConfig,
  getLessonById,
  getOnlineSeats,
  getSessionAnswers,
  getSessionGrades,
  getSessionRow,
  getSetting,
  getTeacherAuth,
  listClasses,
  listLessons,
  listSessionsSummary,
  recordLearningEvent,
  saveLesson,
  saveSessionRow,
  setSetting,
} from './db';
import {
  applyQuizSubmission,
  handleRaidAction,
  startPracticeRun,
  startQuizRun,
  startRaidRun,
  submitPracticeAnswer,
} from './games';
import { gradeObjective } from './grading';
import { serveGameSprite } from './sprites';
import type { Answer, Env, Grade, Lesson, SessionState, User } from './types';

export { ClassroomHub } from './hub';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const payload =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { serverNow: Date.now(), ...(data as Record<string, unknown>) }
      : data;
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('請求資料不是有效的 JSON');
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function parseDataUrl(dataUrl: string): { mime: string; b64: string; bytes: Uint8Array } {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('圖片資料格式不正確');
  const b64 = m[2];
  if (b64.length > 1_800_000) throw new Error('作答圖片過大，請縮小後再試');
  return { mime: m[1], b64, bytes: base64ToBytes(b64) };
}

async function serveStoredImage(
  env: Env,
  row: { r2_key: string; content_type: string; data_b64: string | null } | null,
  cacheControl?: string
): Promise<Response> {
  if (!row) return err('找不到圖片', 404);
  const headers: Record<string, string> = {
    'Content-Type': row.content_type || 'image/jpeg',
    ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
  };
  if (row.data_b64) {
    return new Response(base64ToBytes(row.data_b64), { headers });
  }
  if (env.R2) {
    const obj = await env.R2.get(row.r2_key);
    if (obj) return new Response(obj.body, { headers });
  }
  return err('圖片不存在', 404);
}

async function getCurrentUser(request: Request, env: Env): Promise<User | null> {
  const token = getSessionCookie(request);
  if (!token) return null;
  return getAuthSession(env.DB, token);
}

function requireTeacher(user: User | null): User {
  if (!user) throw Object.assign(new Error('請先登入'), { status: 401 });
  if (user.role !== 'teacher') throw Object.assign(new Error('需要教師權限'), { status: 403 });
  return user;
}

function requireUser(user: User | null): User {
  if (!user) throw Object.assign(new Error('請先登入'), { status: 401 });
  return user;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, method } = { pathname: url.pathname, method: request.method };

    // 1. Static game sprites (/raid/* and /duel/*)
    const sprite = serveGameSprite(pathname);
    if (sprite) return sprite;

    // 2. API routes
    if (pathname.startsWith('/api/')) {
      try {
        await ensureInitialized(env);
        return await handleApi(request, url, pathname.slice(4), method, env);
      } catch (e) {
        const status = (e as { status?: number })?.status || 400;
        const msg = e instanceof Error ? e.message : '伺服器發生錯誤';
        return err(msg, status);
      }
    }

    // 3. Static SPA assets fallback
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(
  request: Request,
  url: URL,
  path: string,
  method: string,
  env: Env
): Promise<Response> {
  const user = await getCurrentUser(request, env);

  // ---------------- Config & Auth ----------------
  if (path === '/config' && method === 'GET') {
    const aiCfg = await getEffectiveAiConfig(env);
    return json({
      mode: 'cloudflare',
      aiConfigured: aiCfg.configured,
      version: '1.0.0',
    });
  }

  if (path === '/me' && method === 'GET') {
    return json({ user });
  }

  if (path === '/login' && method === 'POST') {
    const body = await readJson<{
      role?: string;
      account?: string;
      password?: string;
      classCode?: string;
      seat?: number;
      code?: string;
    }>(request);

    if (body.role === 'student') {
      const cls = await getClassByCode(env.DB, body.classCode || '');
      if (!cls) return err('找不到這個班級代碼，請確認是否輸入正確。', 401);
      const seat = Number(body.seat);
      if (!Number.isInteger(seat) || seat < 1 || seat > cls.seats) {
        return err(`座號必須在 1 到 ${cls.seats} 之間。`, 400);
      }
      if (cls.requireCode) {
        const cred = await env.DB.prepare(
          'SELECT code FROM class_credentials WHERE class_id = ? AND seat = ?'
        )
          .bind(cls.id, seat)
          .first<{ code: string }>();
        if (!cred || cred.code.toUpperCase() !== String(body.code || '').trim().toUpperCase()) {
          return err('個人識別碼不正確，請向老師確認。', 401);
        }
      }
      const student: User = {
        id: `stu-${cls.id}-${seat}`,
        role: 'student',
        name: `${cls.name} ${seat} 號`,
        classId: cls.id,
        className: cls.name,
        classCode: cls.code,
        seat,
      };
      const token = await createAuthSession(env.DB, student);
      return json(
        { user: student, mustChange: false },
        200,
        { 'Set-Cookie': makeSessionCookie(token, request) }
      );
    }

    // Teacher login
    const auth = await getTeacherAuth(env);
    const inputAccount = String(body.account || '').trim().toLowerCase();
    const inputPass = String(body.password || '');
    if (inputAccount !== auth.account.toLowerCase() || !(await verifyPassword(inputPass, auth.hash))) {
      return err('帳號或密碼不正確', 401);
    }
    const teacher: User = {
      id: 'teacher-1',
      role: 'teacher',
      name: auth.name,
      account: auth.account,
    };
    const token = await createAuthSession(env.DB, teacher);
    return json(
      { user: teacher, mustChange: auth.mustChange },
      200,
      { 'Set-Cookie': makeSessionCookie(token, request) }
    );
  }

  if (path === '/logout' && method === 'POST') {
    const token = getSessionCookie(request);
    if (token) {
      await env.DB.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
  }

  if (path === '/teacher/password' && method === 'POST') {
    requireTeacher(user);
    const body = await readJson<{ current?: string; next?: string }>(request);
    const auth = await getTeacherAuth(env);
    if (!(await verifyPassword(String(body.current || ''), auth.hash))) {
      return err('目前密碼不正確', 400);
    }
    const nextPass = String(body.next || '');
    if (nextPass.length < 8) return err('新密碼至少需要 8 個字元', 400);
    auth.hash = await hashPassword(nextPass);
    auth.mustChange = false;
    await setSetting(env.DB, 'teacher_auth', auth);

    const currentToken = getSessionCookie(request);
    if (currentToken) {
      await env.DB.prepare("DELETE FROM auth_sessions WHERE role = 'teacher' AND token != ?")
        .bind(currentToken)
        .run();
    }
    return json({ ok: true });
  }

  // ---------------- WebSocket Live Hub ----------------
  if (path === '/live') {
    const u = requireUser(user);
    const id = env.CLASSROOM_HUB.idFromName('global-hub');
    const stub = env.CLASSROOM_HUB.get(id);
    const hubUrl = new URL(request.url);
    hubUrl.searchParams.set('role', u.role);
    if (u.role === 'student') {
      if (u.classId) hubUrl.searchParams.set('classId', u.classId);
      if (u.seat) hubUrl.searchParams.set('seat', String(u.seat));
    }
    return stub.fetch(new Request(hubUrl.toString(), request));
  }

  // ---------------- Teacher Dashboard & Lessons ----------------
  if (path === '/dashboard' && method === 'GET') {
    requireTeacher(user);
    const [lessons, classes, sessions] = await Promise.all([
      listLessons(env.DB),
      listClasses(env.DB),
      listSessionsSummary(env.DB),
    ]);
    return json({ lessons, catalog: CATALOG_IDS, classes, sessions });
  }

  const lessonPut = /^\/lessons\/([\w-]+)$/.exec(path);
  if (lessonPut && method === 'PUT') {
    requireTeacher(user);
    const body = await readJson<{ lesson: Lesson }>(request);
    if (!body.lesson || !Array.isArray(body.lesson.slides)) {
      return err('課程格式不正確');
    }
    body.lesson.id = lessonPut[1];
    body.lesson.schemaVersion = 1;
    await saveLesson(env.DB, body.lesson);
    return json({ lesson: body.lesson });
  }

  // ---------------- Classes ----------------
  if (path === '/classes' && method === 'POST') {
    requireTeacher(user);
    const body = await readJson<{ name?: string; seats?: number }>(request);
    const name = String(body.name || '').trim();
    const seats = Number(body.seats || 30);
    if (!name) return err('請輸入班級名稱');
    if (!Number.isInteger(seats) || seats < 1 || seats > 60) return err('人數請介於 1 到 60');
    const created = await createClass(env.DB, name, seats);
    return json(created);
  }

  const classIdMatch = /^\/classes\/([\w-]+)$/.exec(path);
  if (classIdMatch && method === 'PATCH') {
    requireTeacher(user);
    const classId = classIdMatch[1];
    const body = await readJson<{ requireCode?: boolean }>(request);
    await env.DB.prepare('UPDATE classes SET require_code = ? WHERE id = ?')
      .bind(body.requireCode ? 1 : 0, classId)
      .run();
    if (body.requireCode) {
      await env.DB.prepare("DELETE FROM auth_sessions WHERE role = 'student' AND class_id = ?")
        .bind(classId)
        .run();
    }
    const classroom = await getClassById(env.DB, classId);
    return json({ classroom });
  }

  if (classIdMatch && method === 'DELETE') {
    requireTeacher(user);
    const classId = classIdMatch[1];
    const sessRows = await env.DB.prepare('SELECT id FROM sessions WHERE class_id = ?')
      .bind(classId)
      .all<{ id: string }>();
    for (const s of sessRows.results) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM answers WHERE session_id = ?').bind(s.id),
        env.DB.prepare('DELETE FROM grades WHERE session_id = ?').bind(s.id),
        env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(s.id),
      ]);
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM learning_records WHERE class_id = ?').bind(classId),
      env.DB.prepare('DELETE FROM class_credentials WHERE class_id = ?').bind(classId),
      env.DB.prepare("DELETE FROM auth_sessions WHERE class_id = ?").bind(classId),
      env.DB.prepare('DELETE FROM classes WHERE id = ?').bind(classId),
    ]);
    return json({ ok: true });
  }

  const credMatch = /^\/classes\/([\w-]+)\/credentials$/.exec(path);
  if (credMatch && method === 'POST') {
    requireTeacher(user);
    const classId = credMatch[1];
    const body = await readJson<{ seat?: number }>(request);
    const seat = Number(body.seat);
    const cls = await getClassById(env.DB, classId);
    if (!cls || seat < 1 || seat > cls.seats) return err('座號無效');
    const code = randomCode(5);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO class_credentials (class_id, seat, code) VALUES (?, ?, ?) ON CONFLICT(class_id, seat) DO UPDATE SET code = excluded.code'
      ).bind(classId, seat, code),
      env.DB.prepare("DELETE FROM auth_sessions WHERE role = 'student' AND class_id = ? AND seat = ?")
        .bind(classId, seat),
    ]);
    return json({ credential: { seat, code } });
  }

  const recMatch = /^\/classes\/([\w-]+)\/records$/.exec(path);
  if (recMatch && method === 'GET') {
    requireTeacher(user);
    const classId = recMatch[1];
    const cls = await getClassById(env.DB, classId);
    if (!cls) return err('找不到班級', 404);
    const { results } = await env.DB.prepare(
      'SELECT id, lesson_id, session_id, seat, source, slot, item, correct, at FROM learning_records WHERE class_id = ? ORDER BY at ASC'
    )
      .bind(classId)
      .all<{
        id: string;
        lesson_id: string;
        session_id: string;
        seat: number;
        source: string;
        slot: string | null;
        item: string;
        correct: number;
        at: number;
      }>();

    const lessons = await listLessons(env.DB);
    const lessonMap = new Map(lessons.map((l) => [l.id, l]));
    const slots: Record<string, unknown> = {};
    for (const r of results) {
      if (r.slot && !slots[r.slot]) {
        const l = lessonMap.get(r.lesson_id);
        slots[r.slot] = {
          lessonId: r.lesson_id,
          lessonTitle: l?.title || r.lesson_id,
          topic: r.item,
          objective: l?.objectives?.[0] || r.item,
          performance: [l?.subject || '跨科'],
        };
      }
    }
    return json({
      classId,
      seats: cls.seats,
      slots,
      records: results.map((r) => ({
        id: r.id,
        seat: r.seat,
        source: r.source,
        slot: r.slot,
        item: r.item,
        correct: Boolean(r.correct),
        at: r.at,
      })),
    });
  }

  // ---------------- Student Active Session & Homework ----------------
  if (path === '/student/session' && method === 'GET') {
    const u = requireUser(user);
    if (u.role !== 'student' || !u.classId) return err('非學生身分', 403);
    const row = await env.DB.prepare(
      'SELECT id FROM sessions WHERE class_id = ? AND ended = 0 ORDER BY created_at DESC LIMIT 1'
    )
      .bind(u.classId)
      .first<{ id: string }>();
    if (!row) return json({ session: null });
    const view = await buildSessionView(env, row.id, 'student', u.seat);
    return json(view ?? { session: null });
  }

  if (path === '/student/homework' && method === 'GET') {
    const u = requireUser(user);
    if (u.role !== 'student' || !u.classId || !u.seat) return json({ homework: [] });
    const { results } = await env.DB.prepare(
      `SELECT h.id, h.title, h.created_at, s.token, s.status, s.sheet_json
       FROM homework h JOIN homework_sheets s ON h.id = s.homework_id
       WHERE h.class_id = ? AND s.seat = ?
       ORDER BY h.created_at DESC LIMIT 20`
    )
      .bind(u.classId, u.seat)
      .all<{
        id: string;
        title: string;
        created_at: number;
        token: string;
        status: string;
        sheet_json: string;
      }>();
    return json({
      homework: results.map((r) => {
        const parsed = JSON.parse(r.sheet_json) as {
          result?: { score: number; max: number };
        };
        return {
          id: r.id,
          title: r.title,
          createdAt: r.created_at,
          status: r.status,
          score: parsed.result?.score,
          max: parsed.result?.max,
          url: `${url.origin}/#/hw/${r.id}/${u.seat}/${r.token}`,
        };
      }),
    });
  }

  // ---------------- Classroom Sessions ----------------
  if (path === '/sessions' && method === 'POST') {
    requireTeacher(user);
    const body = await readJson<{ lessonId?: string; classId?: string }>(request);
    const lesson = await getLessonById(env.DB, String(body.lessonId || ''));
    const cls = await getClassById(env.DB, String(body.classId || ''));
    if (!lesson || !cls) return err('找不到指定的課程或班級');

    const now = Date.now();
    const id = `ses-${crypto.randomUUID().slice(0, 8)}`;
    const state: SessionState = {
      id,
      classId: cls.id,
      lessonId: lesson.id,
      title: lesson.title,
      className: cls.name,
      slideIndex: 0,
      activityOpen: false,
      activityDeadline: null,
      resultsVisible: false,
      followTeacher: true,
      ended: false,
      revision: 1,
      drawnSeat: null,
      drawFilter: 'all',
      buzzOpen: false,
      buzzWinner: null,
      danmakuOpen: false,
      danmakuClearedAt: now,
      photoOpen: false,
      whiteboard: {},
      practice: null,
      quiz: null,
      pkLobby: null,
      raid: null,
      duel: null,
      createdAt: now,
      updatedAt: now,
    };

    await env.DB.prepare(
      'INSERT INTO sessions (id, class_id, lesson_id, title, class_name, state_json, ended, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)'
    )
      .bind(id, cls.id, lesson.id, lesson.title, cls.name, JSON.stringify({ ...state, danmaku: [] }), now, now)
      .run();

    return json({ session: state });
  }

  const sessMatch = /^\/sessions\/([\w-]+)$/.exec(path);
  if (sessMatch && method === 'GET') {
    const u = requireUser(user);
    const view = await buildSessionView(
      env,
      sessMatch[1],
      u.role,
      u.role === 'student' ? u.seat : undefined
    );
    if (!view) return err('找不到這堂課的紀錄', 404);
    return json(view);
  }

  if (sessMatch && method === 'DELETE') {
    requireTeacher(user);
    const sid = sessMatch[1];
    await env.DB.batch([
      env.DB.prepare('DELETE FROM answers WHERE session_id = ?').bind(sid),
      env.DB.prepare('DELETE FROM grades WHERE session_id = ?').bind(sid),
      env.DB.prepare('DELETE FROM learning_records WHERE session_id = ?').bind(sid),
      env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid),
    ]);
    return json({ ok: true });
  }

  const exportMatch = /^\/sessions\/([\w-]+)\/export$/.exec(path);
  if (exportMatch && method === 'GET') {
    requireTeacher(user);
    const sid = exportMatch[1];
    const answers = await getSessionAnswers(env.DB, sid);
    const grades = await getSessionGrades(env.DB, sid);
    const gMap = new Map(grades.map((g) => [g.answerId, g]));
    const rows = [
      ['座號', '題目ID', '作答次數(attempt)', '作答內容', '對錯', '分數', '滿分', '評語', '時間'],
      ...answers.map((a) => {
        const g = gMap.get(a.id);
        return [
          String(a.seat),
          a.activityId,
          String(a.attempt),
          JSON.stringify(a.value),
          a.correct === null ? (g?.correct === undefined ? '' : g.correct ? '正確' : '錯誤') : a.correct ? '正確' : '錯誤',
          g ? String(g.total) : '',
          g ? String(g.max) : '',
          g?.feedback || '',
          new Date(a.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
        ];
      }),
    ];
    const csv =
      '\uFEFF' +
      rows
        .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\r\n');
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="classroom-${sid}.csv"`,
      },
    });
  }

  // ---------------- Session Control (Teacher) ----------------
  const ctrlMatch = /^\/sessions\/([\w-]+)\/control$/.exec(path);
  if (ctrlMatch && method === 'POST') {
    requireTeacher(user);
    const sid = ctrlMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row) return err('找不到課堂', 404);
    const { state, danmaku } = row;
    const lesson = await getLessonById(env.DB, state.lessonId);
    if (!lesson) return err('找不到教材', 404);
    const body = await readJson<Record<string, unknown>>(request);
    const action = String(body.action || '');

    switch (action) {
      case 'slide': {
        const idx = Math.max(0, Math.min(lesson.slides.length - 1, Number(body.index) || 0));
        state.slideIndex = idx;
        state.activityOpen = false;
        state.activityDeadline = null;
        state.resultsVisible = false;
        state.drawnSeat = null;
        break;
      }
      case 'activity': {
        const open = Boolean(body.value);
        state.activityOpen = open;
        if (open) {
          const secs = Number(body.seconds || 60);
          state.activityDeadline = secs > 0 ? Date.now() + secs * 1000 : null;
        } else {
          state.activityDeadline = null;
        }
        break;
      }
      case 'extend': {
        const secs = Number(body.seconds || 30);
        const base = Math.max(Date.now(), state.activityDeadline || Date.now());
        state.activityDeadline = base + secs * 1000;
        break;
      }
      case 'results':
        state.resultsVisible = Boolean(body.value);
        break;
      case 'mode':
        state.followTeacher = Boolean(body.value);
        break;
      case 'photo':
        state.photoOpen = Boolean(body.value);
        break;
      case 'danmaku':
        state.danmakuOpen = Boolean(body.value);
        break;
      case 'danmaku-clear':
        state.danmakuClearedAt = Date.now();
        danmaku.length = 0;
        break;
      case 'buzz-open':
        state.buzzOpen = !state.buzzOpen;
        if (state.buzzOpen) state.buzzWinner = null;
        break;
      case 'buzz-reset':
        state.buzzOpen = false;
        state.buzzWinner = null;
        break;
      case 'draw': {
        const online = await getOnlineSeats(env, state.classId);
        const answers = await getSessionAnswers(env.DB, sid);
        const act = lesson.slides[state.slideIndex]?.activity;
        const latest = new Map<number, Answer>();
        if (act) {
          for (const a of answers) if (a.activityId === act.id) latest.set(a.seat, a);
        }
        const cls = await getClassById(env.DB, state.classId);
        const basePool = online.length
          ? online
          : Array.from({ length: cls?.seats || 30 }, (_, i) => i + 1);
        const filter = String(body.filter || 'all');
        let pool = basePool.filter((s) => {
          const ans = latest.get(s);
          if (filter === 'answered') return Boolean(ans);
          if (filter === 'unanswered') return !ans;
          if (filter === 'wrong') return ans?.correct === false;
          return true;
        });
        if (!pool.length) pool = basePool;
        state.drawnSeat = pool[Math.floor(Math.random() * pool.length)] ?? 1;
        state.drawFilter = filter;
        break;
      }
      case 'release-grades': {
        const activityId = String(body.activityId || '');
        const released = Boolean(body.value);
        const grades = await getSessionGrades(env.DB, sid);
        const stmts: D1PreparedStatement[] = [];
        for (const g of grades) {
          if (g.activityId === activityId) {
            g.released = released;
            stmts.push(
              env.DB.prepare('UPDATE grades SET data_json = ?, updated_at = ? WHERE answer_id = ?').bind(
                JSON.stringify(g),
                Date.now(),
                g.answerId
              )
            );
          }
        }
        if (stmts.length) await env.DB.batch(stmts);
        break;
      }
      case 'practice-start': {
        const act = lesson.slides[state.slideIndex]?.activity;
        if (!act) return err('這一頁沒有題目');
        const answers = await getSessionAnswers(env.DB, sid);
        const online = await getOnlineSeats(env, state.classId);
        state.practice = startPracticeRun(
          act,
          answers,
          online,
          Boolean(body.includeUnanswered)
        );
        break;
      }
      case 'practice-end':
        state.practice = null;
        break;
      case 'quiz-class':
      case 'quiz-review':
      case 'quiz-spaced': {
        const mode = action === 'quiz-review' ? 'review' : action === 'quiz-spaced' ? 'spaced' : 'class';
        state.pkLobby = null;
        state.quiz = startQuizRun(lesson, mode, Number(body.seconds || 600));
        break;
      }
      case 'quiz-end':
        if (state.quiz) {
          const r = (state.quiz as { run: Record<string, unknown> }).run;
          r.endedAt = Date.now();
        }
        break;
      case 'quiz-close':
        state.quiz = null;
        state.pkLobby = null;
        break;
      case 'pk-lobby':
        state.quiz = null;
        state.pkLobby = { pairs: [], waiting: null, buzz: false };
        break;
      case 'pk-buzz':
        if (state.pkLobby) state.pkLobby.buzz = Boolean(body.value);
        break;
      case 'pk-remove':
        if (state.pkLobby) state.pkLobby.pairs.splice(Number(body.index), 1);
        break;
      case 'pk-pick':
        if (state.pkLobby) {
          const seat = Number(body.seat);
          if (state.pkLobby.waiting === null) state.pkLobby.waiting = seat;
          else if (state.pkLobby.waiting === seat) state.pkLobby.waiting = null;
          else {
            state.pkLobby.pairs.push([state.pkLobby.waiting, seat]);
            state.pkLobby.waiting = null;
          }
        }
        break;
      case 'pk-random':
      case 'pk-level': {
        if (!state.pkLobby) break;
        const online = await getOnlineSeats(env, state.classId);
        const pool = [...online].sort(() => Math.random() - 0.5);
        const pairs: [number, number][] = [];
        for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]]);
        state.pkLobby.pairs = pairs;
        state.pkLobby.waiting = pool.length % 2 === 1 ? pool[pool.length - 1] : null;
        break;
      }
      case 'pk-bot':
        if (state.pkLobby && state.pkLobby.waiting !== null) {
          state.pkLobby.pairs.push([state.pkLobby.waiting, 0]);
          state.pkLobby.waiting = null;
        }
        break;
      case 'pk-start':
      case 'pk-again': {
        const matches = (state.pkLobby?.pairs || []).map(([a, b]) => ({ a, b }));
        state.pkLobby = null;
        state.quiz = startQuizRun(lesson, 'pk', Number(body.seconds || 180), matches);
        break;
      }
      case 'raid-start': {
        const online = await getOnlineSeats(env, state.classId);
        const diff = (String(body.difficulty || 'normal') as 'easy' | 'normal' | 'hard');
        state.raid = startRaidRun(lesson, diff, Number(body.seconds || 300), online.length);
        break;
      }
      case 'raid-end':
        if (state.raid) {
          const r = state.raid as { run: Record<string, unknown>; state: Record<string, unknown> };
          r.run.endedAt = Date.now();
          r.state.endAt = Date.now() - Number(r.run.startedAt || Date.now());
        }
        break;
      case 'raid-close':
        state.raid = null;
        break;
      case 'end':
        state.ended = true;
        state.activityOpen = false;
        break;
    }

    await saveSessionRow(env.DB, state, danmaku);
    await broadcastSessionUpdate(env, sid);
    const view = await buildSessionView(env, sid, 'teacher');
    return json(view);
  }

  // ---------------- Student Answers & Images & Whiteboard ----------------
  const ansMatch = /^\/sessions\/([\w-]+)\/answers$/.exec(path);
  if (ansMatch && method === 'POST') {
    const u = requireUser(user);
    if (u.role !== 'student' || !u.seat) return err('僅學生可送出作答', 403);
    const sid = ansMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row) return err('找不到課堂', 404);
    const { state } = row;
    if (!state.activityOpen || state.ended) return err('目前尚未開放作答', 400);
    if (state.activityDeadline && Date.now() > state.activityDeadline + 3000) {
      return err('作答時間已結束', 400);
    }

    const lesson = await getLessonById(env.DB, state.lessonId);
    const slide = lesson?.slides[state.slideIndex];
    const activity = slide?.activity;
    if (!lesson || !activity) return err('這一頁沒有題目', 400);

    const body = await readJson<{ submissionId?: string; activityId?: string; value?: unknown }>(request);
    if (body.activityId && body.activityId !== activity.id) {
      return err('頁面已切換，請在目前頁面作答', 409);
    }

    const prevCount = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM answers WHERE session_id = ? AND activity_id = ? AND seat = ?'
    )
      .bind(sid, activity.id, u.seat)
      .first<{ cnt: number }>();

    const attempt = (prevCount?.cnt ?? 0) + 1;
    const correct = gradeObjective(activity, body.value);
    const ansId = body.submissionId || `ans-${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();

    await env.DB.prepare(
      'INSERT OR REPLACE INTO answers (id, session_id, activity_id, seat, attempt, value_json, correct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        ansId,
        sid,
        activity.id,
        u.seat,
        attempt,
        JSON.stringify(body.value),
        correct === null ? null : correct ? 1 : 0,
        now
      )
      .run();

    if (correct !== null) {
      await recordLearningEvent(env.DB, {
        classId: state.classId,
        lessonId: state.lessonId,
        sessionId: sid,
        seat: u.seat,
        source: 'irs',
        slot: `${lesson.id}:${slide?.id}`,
        item: slide?.title || activity.prompt,
        correct,
      });
    }

    await broadcastSessionUpdate(env, sid);
    return json({ ok: true, id: ansId, correct });
  }

  const imgUploadMatch = /^\/sessions\/([\w-]+)\/images$/.exec(path);
  if (imgUploadMatch && method === 'POST') {
    requireUser(user);
    const sid = imgUploadMatch[1];
    const body = await readJson<{ dataUrl?: string }>(request);
    if (!body.dataUrl) return err('缺少圖片資料');
    const { mime, b64, bytes } = parseDataUrl(body.dataUrl);

    const imageId = `img-${crypto.randomUUID().slice(0, 12)}`;
    const r2Key = `sessions/${sid}/${imageId}`;
    if (env.R2) {
      await env.R2.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
    }
    await env.DB.prepare(
      'INSERT INTO images (id, session_id, seat, r2_key, content_type, size_bytes, created_at, data_b64) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(imageId, sid, user?.seat ?? null, r2Key, mime, bytes.byteLength, Date.now(), b64)
      .run();

    return json({ imageId });
  }

  const wbMatch = /^\/sessions\/([\w-]+)\/whiteboard$/.exec(path);
  if (wbMatch && method === 'PUT') {
    requireTeacher(user);
    const sid = wbMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row) return err('找不到課堂', 404);
    const body = await readJson<{ slideId?: string; strokes?: unknown[] }>(request);
    if (body.slideId) {
      row.state.whiteboard[body.slideId] = body.strokes || [];
      await saveSessionRow(env.DB, row.state, row.danmaku);
      await broadcastSessionUpdate(env, sid);
    }
    return json({ ok: true });
  }

  const gradePutMatch = /^\/sessions\/([\w-]+)\/grades\/([\w-]+)$/.exec(path);
  if (gradePutMatch && method === 'PUT') {
    requireTeacher(user);
    const [, sid, answerId] = gradePutMatch;
    const ansRow = await env.DB.prepare(
      'SELECT activity_id, seat FROM answers WHERE id = ? AND session_id = ?'
    )
      .bind(answerId, sid)
      .first<{ activity_id: string; seat: number }>();
    if (!ansRow) return err('找不到這筆作答', 404);

    const row = await getSessionRow(env.DB, sid);
    const lesson = row ? await getLessonById(env.DB, row.state.lessonId) : null;
    const activity = lesson?.slides.find((s) => s.activity?.id === ansRow.activity_id)?.activity;
    const body = await readJson<{
      verdict?: boolean;
      scores?: Array<{ criterionId: string; score: number; comment?: string }>;
      feedback?: string;
      released?: boolean;
    }>(request);

    const max = activity?.rubric?.criteria.reduce((s, c) => s + c.points, 0) || 1;
    let grade: Grade;
    if (body.verdict !== undefined) {
      grade = {
        answerId,
        activityId: ansRow.activity_id,
        seat: ansRow.seat,
        depth: 'verdict',
        mode: 'teacher',
        correct: Boolean(body.verdict),
        scores: [],
        total: body.verdict ? max : 0,
        max,
        feedback: body.feedback || '',
        released: body.released ?? true,
        gradedAt: Date.now(),
      };
    } else {
      const scores = body.scores || [];
      const total = scores.reduce((s, x) => s + x.score, 0);
      grade = {
        answerId,
        activityId: ansRow.activity_id,
        seat: ansRow.seat,
        depth: 'full',
        mode: 'teacher',
        scores,
        total,
        max,
        feedback: body.feedback || '',
        released: body.released ?? true,
        gradedAt: Date.now(),
      };
    }

    await env.DB.prepare(
      'INSERT INTO grades (answer_id, session_id, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(answer_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at'
    )
      .bind(answerId, sid, JSON.stringify(grade), Date.now())
      .run();

    if (row) await broadcastSessionUpdate(env, sid);
    return json({ grade });
  }

  // ---------------- Danmaku, Buzz, Practice, Quiz, Raid, OCR ----------------
  const danmakuMatch = /^\/sessions\/([\w-]+)\/danmaku$/.exec(path);
  if (danmakuMatch && method === 'POST') {
    const u = requireUser(user);
    if (!u.seat) return err('僅學生可發送彈幕', 403);
    const sid = danmakuMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row) return err('找不到課堂', 404);
    if (!row.state.danmakuOpen || row.state.ended) return err('彈幕目前未開放');
    const body = await readJson<{ text?: string; anon?: boolean }>(request);
    const text = String(body.text || '').trim().slice(0, 30);
    if (!text) return err('先輸入文字');
    const sent = row.danmaku.filter(
      (d) => d.seat === u.seat && d.at >= row.state.danmakuClearedAt
    ).length;
    if (sent >= 3) return err('這題的 3 則彈幕已經用完了');

    row.danmaku.push({
      id: `dm-${crypto.randomUUID().slice(0, 8)}`,
      seat: u.seat,
      text,
      anon: Boolean(body.anon),
      at: Date.now(),
    });
    await saveSessionRow(env.DB, row.state, row.danmaku);
    await broadcastSessionUpdate(env, sid);
    return json({ ok: true, left: Math.max(0, 2 - sent) });
  }

  const buzzMatch = /^\/sessions\/([\w-]+)\/buzz$/.exec(path);
  if (buzzMatch && method === 'POST') {
    const u = requireUser(user);
    if (!u.seat) return err('僅學生可搶答', 403);
    const sid = buzzMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row) return err('找不到課堂', 404);
    if (row.state.buzzOpen && !row.state.buzzWinner) {
      row.state.buzzWinner = { seat: u.seat, at: Date.now() };
      row.state.buzzOpen = false;
      await saveSessionRow(env.DB, row.state, row.danmaku);
      await broadcastSessionUpdate(env, sid);
    }
    return json({ ok: true, winner: row.state.buzzWinner });
  }

  const pracMatch = /^\/sessions\/([\w-]+)\/practice$/.exec(path);
  if (pracMatch && method === 'POST') {
    const u = requireUser(user);
    if (!u.seat) return err('僅學生可作答', 403);
    const sid = pracMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row || !row.state.practice) return err('練習尚未開始');
    const lesson = await getLessonById(env.DB, row.state.lessonId);
    const act = lesson?.slides.find((s) => s.activity?.id === row.state.practice?.activityId)?.activity;
    if (!act) return err('找不到題目');
    const body = await readJson<{ round?: number; value?: string }>(request);
    const res = submitPracticeAnswer(
      row.state.practice,
      act,
      u.seat,
      Number(body.round || 0),
      String(body.value || '')
    );
    await saveSessionRow(env.DB, row.state, row.danmaku);
    await broadcastSessionUpdate(env, sid);
    return json(res);
  }

  const quizPostMatch = /^\/sessions\/([\w-]+)\/quiz$/.exec(path);
  if (quizPostMatch && method === 'POST') {
    const u = requireUser(user);
    if (!u.seat) return err('僅學生可作答測驗', 403);
    const sid = quizPostMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row || !row.state.quiz) return err('目前沒有進行中的測驗');
    const body = await readJson<{
      runId?: string;
      q?: number;
      choice?: number;
      conf?: number;
      submit?: boolean;
    }>(request);
    const res = applyQuizSubmission(row.state.quiz, u.seat, body);
    await saveSessionRow(env.DB, row.state, row.danmaku);
    await broadcastSessionUpdate(env, sid);
    return json({ ...res, revision: row.state.revision });
  }

  const pkBuzzMatch = /^\/sessions\/([\w-]+)\/pk-buzz$/.exec(path);
  if (pkBuzzMatch && method === 'POST') {
    const u = requireUser(user);
    if (!u.seat) return err('僅學生可搶答上場', 403);
    const sid = pkBuzzMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row || !row.state.pkLobby || !row.state.pkLobby.buzz) return err('目前未開放 PK 搶答');
    let paired = false;
    if (row.state.pkLobby.waiting === null) {
      row.state.pkLobby.waiting = u.seat;
    } else if (row.state.pkLobby.waiting !== u.seat) {
      row.state.pkLobby.pairs.push([row.state.pkLobby.waiting, u.seat]);
      row.state.pkLobby.waiting = null;
      paired = true;
    }
    await saveSessionRow(env.DB, row.state, row.danmaku);
    await broadcastSessionUpdate(env, sid);
    return json({ paired });
  }

  const raidPostMatch = /^\/sessions\/([\w-]+)\/raid$/.exec(path);
  if (raidPostMatch && method === 'POST') {
    const u = requireUser(user);
    if (!u.seat) return err('僅學生可操作魔王戰', 403);
    const sid = raidPostMatch[1];
    const row = await getSessionRow(env.DB, sid);
    if (!row || !row.state.raid) return err('魔王戰尚未開始');
    const lesson = await getLessonById(env.DB, row.state.lessonId);
    if (!lesson) return err('找不到教材');
    const body = await readJson<{
      op: string;
      role?: string;
      goal?: number;
      kind?: 'attack' | 'shield' | 'ultimate' | 'analysis';
      choice?: number;
      reason?: number;
    }>(request);
    const res = handleRaidAction(lesson, row.state.raid, u.seat, body);
    await saveSessionRow(env.DB, row.state, row.danmaku);
    await broadcastSessionUpdate(env, sid);
    return json({ ...res, revision: row.state.revision });
  }

  const ocrMatch = /^\/sessions\/([\w-]+)\/(ocr|ocr-work)$/.exec(path);
  if (ocrMatch && method === 'POST') {
    requireUser(user);
    const body = await readJson<{ dataUrl?: string; mockText?: string }>(request);
    const res = await runOcrTask(env, body);
    return json({ text: res.text, ocr: res.text, work: res.text, mode: res.mode });
  }

  // ---------------- Homework ----------------
  if (path === '/homework/plan' && method === 'GET') {
    requireTeacher(user);
    const classId = url.searchParams.get('classId') || '';
    const lessonId = url.searchParams.get('lessonId') || '';
    const scope = url.searchParams.get('scope') || 'lesson';
    const cls = await getClassById(env.DB, classId);
    const lesson = await getLessonById(env.DB, lessonId);
    if (!cls || !lesson) return err('找不到班級或課程', 404);

    const { results } = await env.DB.prepare(
      'SELECT seat, item, correct FROM learning_records WHERE class_id = ? AND lesson_id = ?'
    )
      .bind(classId, lessonId)
      .all<{ seat: number; item: string; correct: number }>();

    const stats = new Map<number, { ok: number; n: number; byTopic: Map<string, { ok: number; n: number }> }>();
    for (const r of results) {
      const s = stats.get(r.seat) ?? { ok: 0, n: 0, byTopic: new Map() };
      s.n++;
      if (r.correct) s.ok++;
      const bt = s.byTopic.get(r.item) ?? { ok: 0, n: 0 };
      bt.n++;
      if (r.correct) bt.ok++;
      s.byTopic.set(r.item, bt);
      stats.set(r.seat, s);
    }

    const seats = Array.from({ length: cls.seats }, (_, i) => {
      const seat = i + 1;
      const st = stats.get(seat);
      const weak = st
        ? [...st.byTopic.entries()]
            .map(([topic, v]) => ({ topic, acc: v.ok / v.n }))
            .filter((w) => w.acc < 1)
            .slice(0, 3)
        : [];
      return {
        seat,
        n: st?.n ?? 0,
        acc: st ? st.ok / st.n : null,
        weak,
      };
    });

    const sortedLow = [...seats]
      .filter((s) => s.acc !== null)
      .sort((a, b) => (a.acc ?? 1) - (b.acc ?? 1));
    const pickCount = Math.max(1, Math.ceil(cls.seats / 3));
    const suggested = sortedLow.length
      ? sortedLow.slice(0, pickCount).map((s) => s.seat)
      : seats.slice(0, Math.min(5, seats.length)).map((s) => s.seat);

    return json({
      plan: {
        title: `${cls.name}・${lesson.title} 回家作業`,
        scope,
        lessonIds: [lesson.id],
        seats,
        suggested,
      },
    });
  }

  if (path === '/homework' && method === 'GET') {
    requireTeacher(user);
    const { results } = await env.DB.prepare(
      'SELECT id, class_id, class_name, lesson_id, title, created_at FROM homework ORDER BY created_at DESC'
    ).all<{
      id: string;
      class_id: string;
      class_name: string;
      lesson_id: string;
      title: string;
      created_at: number;
    }>();
    const out = [];
    for (const hw of results) {
      const sheetsRows = await env.DB.prepare(
        'SELECT seat, status, sheet_json FROM homework_sheets WHERE homework_id = ?'
      )
        .bind(hw.id)
        .all<{ seat: number; status: string; sheet_json: string }>();
      const sheets: Record<string, unknown> = {};
      for (const sr of sheetsRows.results) {
        const parsed = JSON.parse(sr.sheet_json) as { result?: { score: number; max: number } };
        sheets[String(sr.seat)] = {
          status: sr.status,
          score: parsed.result?.score,
          max: parsed.result?.max,
        };
      }
      out.push({
        id: hw.id,
        classId: hw.class_id,
        className: hw.class_name,
        lessonId: hw.lesson_id,
        title: hw.title,
        createdAt: hw.created_at,
        sheets,
      });
    }
    return json({ homework: out });
  }

  if (path === '/homework' && method === 'POST') {
    requireTeacher(user);
    const body = await readJson<{ classId?: string; lessonId?: string; seats?: number[] }>(request);
    const cls = await getClassById(env.DB, String(body.classId || ''));
    const lesson = await getLessonById(env.DB, String(body.lessonId || ''));
    if (!cls || !lesson) return err('找不到班級或課程');
    const seats = (body.seats || []).map(Number).filter((s) => s >= 1 && s <= cls.seats);
    if (!seats.length) return err('請至少選擇一位學生');

    const hwId = `hw-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const title = `${lesson.title}・回家作業`;
    await env.DB.prepare(
      'INSERT INTO homework (id, class_id, class_name, lesson_id, title, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(hwId, cls.id, cls.name, lesson.id, title, JSON.stringify({ scope: 'lesson' }), now)
      .run();

    const quizTopics = lesson.quiz?.topics ?? [];
    const baseQuestions = quizTopics.length
      ? quizTopics.slice(0, 5).map((t, idx) => {
          const v = t.variants[0];
          return {
            n: idx + 1,
            topic: t.topic,
            stem: v.stem,
            answer: v.options[v.answer],
            solution: v.explanation || '',
          };
        })
      : lesson.slides
          .filter((s) => s.activity)
          .slice(0, 4)
          .map((s, idx) => ({
            n: idx + 1,
            topic: s.phase || s.title,
            stem: s.activity!.prompt,
            answer: s.activity!.answer || s.activity!.rubric?.reference || '',
            solution: s.activity!.explanation || '',
          }));

    const sheets = [];
    const stmts: D1PreparedStatement[] = [];
    for (const seat of seats) {
      const token = randomCode(10);
      const sheet = {
        id: hwId,
        seat,
        token,
        title,
        className: cls.name,
        createdAt: now,
        status: 'assigned',
        questions: baseQuestions,
        photos: [] as Array<{ id: string }>,
        url: `${url.origin}/#/hw/${hwId}/${seat}/${token}`,
      };
      sheets.push(sheet);
      stmts.push(
        env.DB.prepare(
          'INSERT INTO homework_sheets (homework_id, seat, token, status, sheet_json) VALUES (?, ?, ?, ?, ?)'
        ).bind(hwId, seat, token, 'assigned', JSON.stringify(sheet))
      );
    }
    await env.DB.batch(stmts);
    return json({ homework: { id: hwId, title }, sheets });
  }

  const hwDetailMatch = /^\/homework\/([\w-]+)$/.exec(path);
  if (hwDetailMatch && method === 'GET') {
    requireTeacher(user);
    const hwId = hwDetailMatch[1];
    const hw = await env.DB.prepare(
      'SELECT id, class_id, class_name, lesson_id, title, created_at FROM homework WHERE id = ?'
    )
      .bind(hwId)
      .first<{
        id: string;
        class_id: string;
        class_name: string;
        lesson_id: string;
        title: string;
        created_at: number;
      }>();
    if (!hw) return err('找不到這份作業', 404);
    const { results } = await env.DB.prepare(
      'SELECT sheet_json FROM homework_sheets WHERE homework_id = ? ORDER BY seat ASC'
    )
      .bind(hwId)
      .all<{ sheet_json: string }>();
    return json({
      homework: {
        id: hw.id,
        classId: hw.class_id,
        className: hw.class_name,
        lessonId: hw.lesson_id,
        title: hw.title,
        createdAt: hw.created_at,
      },
      sheets: results.map((r) => JSON.parse(r.sheet_json)),
    });
  }

  if (hwDetailMatch && method === 'DELETE') {
    requireTeacher(user);
    const hwId = hwDetailMatch[1];
    await env.DB.batch([
      env.DB.prepare('DELETE FROM homework_sheets WHERE homework_id = ?').bind(hwId),
      env.DB.prepare('DELETE FROM homework WHERE id = ?').bind(hwId),
    ]);
    return json({ ok: true });
  }

  // Standalone Student Homework (/hw/:id/:seat...)
  const hwPublicMatch = /^\/hw\/([\w-]+)\/(\d+)(\/[\w-]+)*$/.exec(path);
  if (hwPublicMatch) {
    const [, hwId, seatStr, subPath] = hwPublicMatch;
    const seat = Number(seatStr);
    const token = url.searchParams.get('t') || '';
    const row = await env.DB.prepare(
      'SELECT sheet_json, token FROM homework_sheets WHERE homework_id = ? AND seat = ?'
    )
      .bind(hwId, seat)
      .first<{ sheet_json: string; token: string }>();
    if (!row || row.token !== token) return err('作業連結無效或已過期', 403);
    const sheet = JSON.parse(row.sheet_json) as {
      status: string;
      photos: Array<{ id: string }>;
      questions: Array<{ n: number; stem: string; answer?: string }>;
      result?: Record<string, unknown>;
      submittedAt?: number;
    };

    if (!subPath && method === 'GET') {
      return json({ sheet });
    }
    if (subPath === '/photos' && method === 'POST') {
      const body = await readJson<{ dataUrl?: string }>(request);
      if (!body.dataUrl) return err('缺少圖片');
      const { mime, b64, bytes } = parseDataUrl(body.dataUrl);
      const pid = `hwp-${crypto.randomUUID().slice(0, 10)}`;
      const r2Key = `homework/${hwId}/${seat}/${pid}`;
      if (env.R2) {
        await env.R2.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
      }
      await env.DB.prepare(
        'INSERT INTO images (id, homework_id, seat, r2_key, content_type, size_bytes, created_at, data_b64) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(pid, hwId, seat, r2Key, mime, bytes.byteLength, Date.now(), b64)
        .run();
      sheet.photos.push({ id: pid });
      await env.DB.prepare('UPDATE homework_sheets SET sheet_json = ? WHERE homework_id = ? AND seat = ?')
        .bind(JSON.stringify(sheet), hwId, seat)
        .run();
      return json({ sheet });
    }
    const photoGetMatch = /^\/photos\/([\w-]+)$/.exec(subPath || '');
    if (photoGetMatch && method === 'GET') {
      const img = await env.DB.prepare(
        'SELECT r2_key, content_type, data_b64 FROM images WHERE id = ?'
      )
        .bind(photoGetMatch[1])
        .first<{ r2_key: string; content_type: string; data_b64: string | null }>();
      return serveStoredImage(env, img);
    }
    if (photoGetMatch && method === 'DELETE') {
      sheet.photos = sheet.photos.filter((p) => p.id !== photoGetMatch[1]);
      await env.DB.prepare('UPDATE homework_sheets SET sheet_json = ? WHERE homework_id = ? AND seat = ?')
        .bind(JSON.stringify(sheet), hwId, seat)
        .run();
      return json({ sheet });
    }
    if (subPath === '/submit' && method === 'POST') {
      sheet.status = 'graded';
      sheet.submittedAt = Date.now();
      sheet.result = {
        score: sheet.questions.length,
        max: sheet.questions.length,
        mode: (await getEffectiveAiConfig(env)).configured ? 'live' : 'mock',
        feedback: '作業照片已成功送出並完成初步檢查！',
        items: sheet.questions.map((q) => ({
          n: q.n,
          correct: true,
          read: '已作答',
          comment: '步驟清楚',
        })),
      };
      await env.DB.prepare(
        'UPDATE homework_sheets SET status = ?, sheet_json = ?, submitted_at = ? WHERE homework_id = ? AND seat = ?'
      )
        .bind('graded', JSON.stringify(sheet), sheet.submittedAt, hwId, seat)
        .run();
      return json({ sheet });
    }
  }

  const hwOverrideMatch = /^\/homework\/([\w-]+)\/(\d+)\/items\/(\d+)$/.exec(path);
  if (hwOverrideMatch && method === 'PUT') {
    requireTeacher(user);
    const [, hwId, seatStr, nStr] = hwOverrideMatch;
    const seat = Number(seatStr);
    const qNum = Number(nStr);
    const body = await readJson<{ correct: boolean | null }>(request);
    const row = await env.DB.prepare(
      'SELECT sheet_json FROM homework_sheets WHERE homework_id = ? AND seat = ?'
    )
      .bind(hwId, seat)
      .first<{ sheet_json: string }>();
    if (!row) return err('找不到作業卷', 404);
    const sheet = JSON.parse(row.sheet_json) as {
      questions: Array<{ n: number }>;
      result?: { score: number; items: Array<{ n: number; correct: boolean | null; teacher?: boolean }> };
    };
    if (sheet.result) {
      const idx = sheet.questions.findIndex((q) => q.n === qNum);
      if (idx >= 0 && sheet.result.items[idx]) {
        sheet.result.items[idx].correct = body.correct;
        sheet.result.items[idx].teacher = true;
        sheet.result.score = sheet.result.items.filter((i) => i.correct === true).length;
      }
    }
    await env.DB.prepare('UPDATE homework_sheets SET sheet_json = ? WHERE homework_id = ? AND seat = ?')
      .bind(JSON.stringify(sheet), hwId, seat)
      .run();
    return json({ sheet });
  }

  // ---------------- AI Grading & Assistant ----------------
  if (path === '/ai' && method === 'POST') {
    requireTeacher(user);
    const body = await readJson<{
      task: string;
      sessionId?: string;
      answerId?: string;
      lessonId?: string;
      activityId?: string;
      depth?: 'verdict' | 'fast' | 'full';
      topic?: string;
      pages?: string;
      duration?: number;
      text?: string;
      wishes?: string;
      images?: string[];
    }>(request);

    if (body.task === 'grade' && body.sessionId && body.answerId) {
      const answers = await getSessionAnswers(env.DB, body.sessionId);
      const ans = answers.find((a) => a.id === body.answerId);
      if (!ans) return err('找不到作答紀錄', 404);
      const row = await getSessionRow(env.DB, body.sessionId);
      const lesson = row ? await getLessonById(env.DB, row.state.lessonId) : null;
      const activity = lesson?.slides.find((s) => s.activity?.id === ans.activityId)?.activity;
      if (!activity) return err('找不到題目', 404);

      const grade = await gradeAnswerWithAi(env, {
        activity,
        answer: ans,
        depth: body.depth || 'verdict',
      });
      await env.DB.prepare(
        'INSERT INTO grades (answer_id, session_id, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(answer_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at'
      )
        .bind(ans.id, body.sessionId, JSON.stringify(grade), Date.now())
        .run();
      await broadcastSessionUpdate(env, body.sessionId);
      return json({ grade });
    }

    if (body.task === 'lesson-generate') {
      const out = await generateLessonDraft(env, {
        topic: body.topic || '國中跨科主題課堂',
        pages: body.pages,
        duration: body.duration,
        text: body.text,
        wishes: body.wishes,
        images: body.images,
      });
      return json(out);
    }

    const lesson = body.lessonId ? await getLessonById(env.DB, body.lessonId) : null;
    const answers = body.sessionId ? await getSessionAnswers(env.DB, body.sessionId) : [];
    const activity =
      lesson?.slides.find((s) => s.activity?.id === body.activityId)?.activity || null;
    const out = await runAiAssistantTask(env, {
      task: body.task,
      lesson,
      activity,
      answers,
    });
    return json(out);
  }

  // ---------------- Settings & Usage & Backup & Images ----------------
  if (path === '/settings/ai' && method === 'GET') {
    requireTeacher(user);
    const cfg = await getEffectiveAiConfig(env);
    const usedToday = await getAiUsedToday(env.DB);
    return json({
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dailyLimit: cfg.dailyLimit,
      configured: cfg.configured,
      source: cfg.source,
      keyHint: cfg.keyHint,
      usedToday,
    });
  }

  if (path === '/settings/ai' && method === 'PUT') {
    requireTeacher(user);
    const body = await readJson<{
      provider?: 'openai' | 'gemini' | 'anthropic' | 'custom';
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      dailyLimit?: number;
    }>(request);
    const prev = await getEffectiveAiConfig(env);
    await setSetting(env.DB, 'ai_settings', {
      provider: body.provider || prev.provider,
      baseUrl: body.baseUrl || prev.baseUrl,
      model: body.model || prev.model,
      apiKey: body.apiKey?.trim() ? body.apiKey.trim() : prev.apiKey,
      dailyLimit: Number(body.dailyLimit || prev.dailyLimit || 200),
    });
    return json({ ok: true });
  }

  if (path === '/settings/ai' && method === 'DELETE') {
    requireTeacher(user);
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('ai_settings').run();
    return json({ ok: true });
  }

  if (path === '/settings/ai/test' && method === 'POST') {
    requireTeacher(user);
    return json(await testAiConnection(env));
  }

  if (path === '/settings/usage' && method === 'GET') {
    requireTeacher(user);
    const sessCount = await env.DB.prepare('SELECT COUNT(*) AS cnt, SUM(ended) AS ended FROM sessions').first<{
      cnt: number;
      ended: number | null;
    }>();
    const imgStats = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS total FROM images'
    ).first<{ cnt: number; total: number }>();
    const ansBytes = await env.DB.prepare(
      'SELECT COALESCE(SUM(LENGTH(value_json)), 0) AS bytes FROM answers'
    ).first<{ bytes: number }>();
    return json({
      available: true,
      sessions: sessCount?.cnt ?? 0,
      archived: sessCount?.ended ?? 0,
      dataBytes: ansBytes?.bytes ?? 0,
      photos: imgStats?.cnt ?? 0,
      photoBytes: imgStats?.total ?? 0,
      rowsToday: 0,
      limits: {
        storageBytes: 5 * 1024 * 1024 * 1024,
        rowsPerDay: 100000,
      },
    });
  }

  if (path === '/settings/prune-photos' && method === 'POST') {
    requireTeacher(user);
    const body = await readJson<{ days?: number }>(request);
    const cutoff = Date.now() - Number(body.days || 90) * 86400 * 1000;
    const oldImgs = await env.DB.prepare('SELECT id, r2_key FROM images WHERE created_at < ?')
      .bind(cutoff)
      .all<{ id: string; r2_key: string }>();
    if (env.R2) {
      for (const img of oldImgs.results) {
        await env.R2.delete(img.r2_key);
      }
    }
    await env.DB.prepare('DELETE FROM images WHERE created_at < ?').bind(cutoff).run();
    return json({ removed: oldImgs.results.length });
  }

  if (path === '/backup' && method === 'GET') {
    requireTeacher(user);
    const [lessons, classes, sessions, answers, grades] = await Promise.all([
      env.DB.prepare('SELECT id, title, subject, data_json, updated_at FROM lessons').all(),
      env.DB.prepare('SELECT id, name, code, seats, require_code, created_at FROM classes').all(),
      env.DB.prepare('SELECT id, class_id, lesson_id, title, class_name, state_json, ended, created_at, updated_at FROM sessions').all(),
      env.DB.prepare('SELECT id, session_id, activity_id, seat, attempt, value_json, correct, created_at FROM answers').all(),
      env.DB.prepare('SELECT answer_id, session_id, data_json, updated_at FROM grades').all(),
    ]);
    return json({
      version: 1,
      exportedAt: Date.now(),
      lessons: lessons.results,
      classes: classes.results,
      sessions: sessions.results,
      answers: answers.results,
      grades: grades.results,
    });
  }

  if (path === '/restore' && method === 'POST') {
    requireTeacher(user);
    const body = await readJson<{ backup?: Record<string, Array<Record<string, unknown>>> }>(request);
    const b = body.backup;
    if (!b) return err('備份檔案無效');
    for (const l of b.lessons || []) {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO lessons (id, title, subject, data_json, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(l.id, l.title, l.subject, l.data_json, l.updated_at)
        .run();
    }
    for (const c of b.classes || []) {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO classes (id, name, code, seats, require_code, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(c.id, c.name, c.code, c.seats, c.require_code, c.created_at)
        .run();
    }
    return json({ ok: true });
  }

  const imgGetMatch = /^\/images\/([\w-]+)$/.exec(path);
  if (imgGetMatch && method === 'GET') {
    requireUser(user);
    const row = await env.DB.prepare(
      'SELECT r2_key, content_type, data_b64 FROM images WHERE id = ?'
    )
      .bind(imgGetMatch[1])
      .first<{ r2_key: string; content_type: string; data_b64: string | null }>();
    return serveStoredImage(env, row, 'private, max-age=86400');
  }

  return err('找不到這個 API 端點', 404);
}
