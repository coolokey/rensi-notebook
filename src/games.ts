import { evalNumeric } from './grading';
import type { Activity, Answer, Lesson, RaidQuestion, SessionState } from './types';

// ========================
// 1. 課後檢核 / PK / 錯題 / 間隔複習
// ========================

export function startQuizRun(
  lesson: Lesson,
  mode: 'class' | 'pk' | 'review' | 'spaced',
  seconds: number,
  matches?: Array<{ a: number; b: number }>
): Record<string, unknown> {
  const topics = lesson.quiz?.topics ?? [];
  const questions = topics.map((t, idx) => {
    const v = t.variants[Math.floor(Math.random() * t.variants.length)] ?? t.variants[0];
    return {
      slot: idx,
      topic: t.topic,
      stem: v.stem,
      options: v.options,
      answer: v.answer,
      explanation: v.explanation,
      figure: v.figure,
    };
  });

  const now = Date.now();
  const startedAt = mode === 'pk' ? now + 5000 : now;

  return {
    run: {
      id: `quiz-${crypto.randomUUID().slice(0, 8)}`,
      mode,
      startedAt,
      seconds,
      ...(matches ? { matches } : {}),
    },
    questions,
    scores: {},
    playerProgress: {},
    prev: {},
  };
}

export function applyQuizSubmission(
  quiz: Record<string, unknown>,
  seat: number,
  payload: { runId?: string; q?: number; choice?: number; conf?: number; submit?: boolean }
): { ok: boolean; correct?: boolean; answer?: number; explanation?: string } {
  const run = quiz.run as { id: string; mode: string; startedAt: number };
  if (payload.runId && payload.runId !== run.id) {
    throw new Error('測驗回合已更新，請重新操作');
  }
  const questions = quiz.questions as Array<{
    slot: number;
    options: string[];
    answer: number;
    explanation?: string;
  }>;
  const playerProgress = (quiz.playerProgress as Record<
    string,
    {
      answers: Array<number | null>;
      correct: Array<boolean | null>;
      conf: Array<number | null>;
      done?: number;
    }
  >) || {};
  const scores = (quiz.scores as Record<
    string,
    { answered: number; correct: number; finished: boolean; timeMs: number | null }
  >) || {};

  const key = String(seat);
  const mine = playerProgress[key] || {
    answers: questions.map(() => null),
    correct: questions.map(() => null),
    conf: questions.map(() => null),
  };

  if (payload.submit) {
    mine.done = Date.now();
    playerProgress[key] = mine;
    const answered = mine.answers.filter((a) => a !== null).length;
    const correctCount = mine.correct.filter((c) => c === true).length;
    scores[key] = {
      answered,
      correct: correctCount,
      finished: true,
      timeMs: Math.max(0, Date.now() - run.startedAt),
    };
    quiz.playerProgress = playerProgress;
    quiz.scores = scores;
    return { ok: true };
  }

  const slot = Number(payload.q);
  const qIdx = questions.findIndex((q) => q.slot === slot);
  if (qIdx < 0) throw new Error('找不到題目');

  if (payload.conf !== undefined) {
    mine.conf[qIdx] = payload.conf;
  }

  let isCorrect: boolean | undefined;
  if (payload.choice !== undefined) {
    const q = questions[qIdx];
    isCorrect = Number(payload.choice) === q.answer;
    mine.answers[qIdx] = Number(payload.choice);
    mine.correct[qIdx] = isCorrect;
  }

  const answered = mine.answers.filter((a) => a !== null).length;
  const correctCount = mine.correct.filter((c) => c === true).length;
  const allDone = answered === questions.length;
  if (allDone && !mine.done) mine.done = Date.now();

  playerProgress[key] = mine;
  scores[key] = {
    answered,
    correct: correctCount,
    finished: allDone,
    timeMs: allDone ? Math.max(0, Date.now() - run.startedAt) : null,
  };

  quiz.playerProgress = playerProgress;
  quiz.scores = scores;

  const q = questions[qIdx];
  return {
    ok: true,
    ...(isCorrect !== undefined ? { correct: isCorrect, answer: q.answer, explanation: q.explanation } : {}),
  };
}

// ========================
// 2. 全班合作魔王戰 (Raid)
// ========================

export function startRaidRun(
  lesson: Lesson,
  difficulty: 'easy' | 'normal' | 'hard',
  seconds: number,
  onlineCount: number
): Record<string, unknown> {
  const raid = lesson.raid;
  if (!raid) throw new Error('這一課沒有魔王戰題庫');

  const playersCount = Math.max(1, onlineCount);
  const mult = difficulty === 'easy' ? 0.75 : difficulty === 'hard' ? 1.35 : 1.0;
  const bossHp = Math.round(playersCount * 120 * mult);
  const teamHp = Math.round(playersCount * 40);
  const hasAnalysis = (raid.pools.analysis?.length ?? 0) > 0;
  const now = Date.now();

  const config: Record<string, unknown> = {
    players: playersCount,
    bossHp,
    teamHp,
    hpScale: 1,
    bossAtk: Math.max(10, Math.round(teamHp * 0.14)),
    bossAtkEvery: 22000,
    bossShieldEvery: 28000,
    bossShieldMax: Math.round(bossHp * 0.15),
    bossShieldGain: Math.round(bossHp * 0.04),
    bossChargeMs: 55000,
    bossWarnMs: 12000,
    bossUlt: Math.max(25, Math.round(teamHp * 0.45)),
    ...(hasAnalysis && difficulty === 'hard'
      ? {
          phase: {
            at: seconds >= 480 ? [70, 35] : [50],
            need: [Math.max(3, Math.ceil(playersCount * 0.15))],
            dmgPct: 50,
            breakMs: 15000,
            breakPct: 200,
            support: 10,
            hintMs: 180000,
            cap: 2,
            atkPct: 25,
            chargePct: 0,
          },
        }
      : {}),
  };

  return {
    run: {
      id: `raid-${crypto.randomUUID().slice(0, 8)}`,
      difficulty,
      seconds,
      startedAt: now + 4000,
      config,
    },
    title: raid.title,
    pools: {
      attack: raid.pools.attack.length,
      shield: raid.pools.shield.length,
      ultimate: raid.pools.ultimate.length,
      analysis: raid.pools.analysis?.length ?? 0,
    },
    roles: {},
    players: {},
    state: {
      t: 0,
      bossHp,
      teamHp,
      bossShield: 0,
      ult: 0,
      ultBy: {},
      nextAtk: 22000,
      nextShield: 28000,
      chargeFrom: 0,
      chargeBonus: 0,
      bossUltAt: null,
      bossUltMove: null,
      shieldBank: [],
      recent: [],
      stats: {},
      tally: {},
      log: [],
      seq: 0,
    },
  };
}

function pickRaidQuestion(lesson: Lesson, kind: 'attack' | 'shield' | 'ultimate' | 'analysis'): RaidQuestion {
  const pool =
    kind === 'analysis'
      ? lesson.raid?.pools.analysis || []
      : lesson.raid?.pools[kind] || [];
  if (!pool.length) {
    const fallback = lesson.raid?.pools.attack || [];
    return fallback[0];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

export function handleRaidAction(
  lesson: Lesson,
  raidState: Record<string, unknown>,
  seat: number,
  body: {
    op: string;
    role?: string;
    goal?: number;
    kind?: 'attack' | 'shield' | 'ultimate' | 'analysis';
    choice?: number;
    reason?: number;
  }
): Record<string, unknown> {
  const run = raidState.run as { startedAt: number; config: Record<string, unknown> };
  const roles = (raidState.roles as Record<string, string>) || {};
  const players = (raidState.players as Record<string, Record<string, unknown>>) || {};
  const st = raidState.state as {
    t: number;
    bossHp: number;
    teamHp: number;
    bossShield: number;
    ult: number;
    ultBy: Record<string, number>;
    chargeBonus: number;
    shieldBank: Array<{ seat: number; ms: number }>;
    recent: Array<{ t: number; kind: string }>;
    stats: Record<
      string,
      {
        n: Record<string, number>;
        ok: Record<string, number>;
        dmg: number;
        blocks: number;
        ults: number;
        streak: number;
        best: number;
        score: number;
      }
    >;
    tally: Record<string, number>;
    log: Array<Record<string, unknown>>;
    seq: number;
    result?: string;
    endAt?: number;
  };

  const key = String(seat);
  const mine = (players[key] ||= {});
  const now = Date.now();
  const elapsed = Math.max(0, now - run.startedAt);
  st.t = Math.max(st.t, elapsed);

  if (body.op === 'role' && body.role) {
    roles[key] = body.role;
    mine.role = body.role;
    raidState.roles = roles;
    return { ok: true };
  }

  if (body.op === 'goal') {
    mine.goal = body.goal;
    return { ok: true, goal: body.goal };
  }

  if (body.op === 'draw' || body.op === 'skip') {
    const kind =
      body.kind ||
      ((mine.question as RaidQuestion | undefined)?.kind as 'attack' | 'shield' | 'ultimate' | 'analysis') ||
      'attack';
    const q = pickRaidQuestion(lesson, kind);
    mine.question = q;
    if (body.op === 'skip') mine.skipAt = now;
    return { ok: true, question: q, skipAt: mine.skipAt };
  }

  if (body.op === 'answer') {
    const q = mine.question as RaidQuestion | undefined;
    if (!q) return { ok: false, taken: true };
    const ansOk = Number(body.choice) === q.answer;
    const reasonOk =
      q.reason && q.reasonAnswer !== undefined ? Number(body.reason) === q.reasonAnswer : true;
    const correct = ansOk && reasonOk;

    const pStat = (st.stats[key] ||= {
      n: { attack: 0, shield: 0, ultimate: 0 },
      ok: { attack: 0, shield: 0, ultimate: 0 },
      dmg: 0,
      blocks: 0,
      ults: 0,
      streak: 0,
      best: 0,
      score: 0,
    });
    const statKind = q.kind === 'analysis' ? 'ultimate' : q.kind;
    pStat.n[statKind] = (pStat.n[statKind] || 0) + 1;

    delete mine.question;

    if (correct) {
      pStat.ok[statKind] = (pStat.ok[statKind] || 0) + 1;
      pStat.streak += 1;
      pStat.best = Math.max(pStat.best, pStat.streak);
      st.recent.push({ t: elapsed, kind: q.kind });
      if (st.recent.length > 40) st.recent.shift();

      let dmg = 0;
      if (q.kind === 'attack') {
        dmg = mine.role === 'archer' ? 39 : 30;
        st.bossHp = Math.max(0, st.bossHp - dmg);
        pStat.dmg += dmg;
        pStat.score += 10;
      } else if (q.kind === 'shield') {
        const msGain = mine.role === 'knight' ? 1500 : 1000;
        st.shieldBank.push({ seat, ms: msGain });
        pStat.blocks += 1;
        pStat.score += 12;
      } else {
        const ultGain = mine.role === 'mage' ? 25 : 20;
        st.ult += ultGain;
        st.ultBy[key] = (st.ultBy[key] || 0) + 1;
        dmg = 45;
        if (st.ult >= 100) {
          st.ult = 0;
          dmg += 90;
          pStat.ults += 1;
          st.log.push({ t: elapsed, k: 'ult', seat, n: dmg });
        }
        st.bossHp = Math.max(0, st.bossHp - dmg);
        pStat.dmg += dmg;
        pStat.score += 15;
      }

      st.seq++;
      st.log.push({ t: elapsed, k: q.kind, seat, n: dmg });
      if (st.log.length > 40) st.log.shift();

      if (st.bossHp <= 0 && !st.result) {
        st.result = 'win';
        st.endAt = elapsed;
        (raidState.run as { endedAt?: number }).endedAt = now;
      }
      return { ok: true, correct: true, dmg, kind: q.kind };
    } else {
      pStat.streak = 0;
      st.chargeBonus += 4000;
      const lockMs = q.kind === 'ultimate' ? 3000 : 5000;
      mine.lockUntil = now + lockMs;
      return { ok: true, correct: false, lockUntil: mine.lockUntil, kind: q.kind };
    }
  }

  return { ok: true };
}

// ========================
// 3. 原題再做一次 / 補救練習 (Practice)
// ========================

export function startPracticeRun(
  activity: Activity,
  answers: Answer[],
  onlineSeats: number[],
  includeUnanswered: boolean
): SessionState['practice'] {
  const latestBySeat = new Map<number, Answer>();
  for (const a of answers) {
    if (a.activityId === activity.id) latestBySeat.set(a.seat, a);
  }

  const targetSeats = new Set<number>();
  for (const [seat, ans] of latestBySeat.entries()) {
    if (ans.correct === false) targetSeats.add(seat);
  }
  if (includeUnanswered) {
    for (const s of onlineSeats) {
      if (!latestBySeat.has(s)) targetSeats.add(s);
    }
  }

  const now = Date.now();
  const seconds = 60;
  const prompts = activity.items
    ? activity.items.map((it) => it.prompt)
    : [activity.prompt];
  const reveals = activity.items
    ? activity.items.map((it, i) => ({
        round: i,
        answer: it.answer,
        explanation: activity.explanation,
      }))
    : [{ round: 0, answer: activity.answer || '', explanation: activity.explanation }];

  const entries = [...targetSeats]
    .sort((a, b) => a - b)
    .map((seat) => ({
      seat,
      items: prompts.map((_, i) => i),
      rounds: [{ round: 0, startedAt: now, deadline: now + seconds * 1000 }],
    }));

  return {
    id: `prac-${crypto.randomUUID().slice(0, 8)}`,
    activityId: activity.id,
    startedAt: now,
    seconds,
    rounds: prompts.length,
    retry: true,
    entries,
    prompts,
    reveals,
  };
}

export function submitPracticeAnswer(
  practice: NonNullable<SessionState['practice']>,
  activity: Activity,
  seat: number,
  round: number,
  value: string
): { correct: boolean } {
  const entry = practice.entries.find((e) => e.seat === seat);
  if (!entry) throw new Error('你沒有被指派這次練習');

  const expected = activity.items
    ? activity.items[round]?.answer ?? ''
    : activity.answer ?? '';
  const sv = evalNumeric(value);
  const ev = evalNumeric(expected);
  const correct =
    value.trim() === expected.trim() ||
    (Number.isFinite(sv) && Number.isFinite(ev) && Math.abs(sv - ev) <= 1e-6);

  const cur = entry.rounds.find((r) => r.round === round);
  if (cur) {
    cur.outcome = correct ? 'correct' : 'wrong';
    cur.value = value;
  }

  if (correct && round + 1 < practice.rounds) {
    const now = Date.now();
    entry.rounds.push({
      round: round + 1,
      startedAt: now,
      deadline: now + practice.seconds * 1000,
    });
  }

  return { correct };
}
