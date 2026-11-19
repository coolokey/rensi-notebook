import type { Activity, Answer } from './types';

function evalArithTokens(expr: string): number {
  const s = String(expr ?? '')
    .normalize('NFKC')
    .replace(/[－−–—]/g, '-')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/\s+/g, '');
  if (!s) return NaN;

  let pos = 0;

  function parseExpr(): number {
    let left = parseTerm();
    while (pos < s.length && (s[pos] === '+' || s[pos] === '-')) {
      const op = s[pos++];
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (pos < s.length && (s[pos] === '*' || s[pos] === '/')) {
      const op = s[pos++];
      const right = parseFactor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number {
    if (s[pos] === '+') {
      pos++;
      return parseFactor();
    }
    if (s[pos] === '-') {
      pos++;
      return -parseFactor();
    }
    if (s[pos] === '(') {
      pos++;
      const val = parseExpr();
      if (s[pos] !== ')') throw new Error('括號未閉合');
      pos++;
      return val;
    }
    if (s.startsWith('sqrt(', pos)) {
      pos += 5;
      const val = parseExpr();
      if (s[pos] !== ')') throw new Error('sqrt 括號未閉合');
      pos++;
      return Math.sqrt(val);
    }
    const m = /^\d+(?:\.\d+)?/.exec(s.slice(pos));
    if (!m) throw new Error('無效數值');
    pos += m[0].length;
    return Number(m[0]);
  }

  try {
    const val = parseExpr();
    if (pos !== s.length || !Number.isFinite(val)) return NaN;
    return val;
  } catch {
    return NaN;
  }
}

export function evalNumeric(raw: string): number {
  return evalArithTokens(raw);
}

export function evalMakeExpression(
  expr: string,
  cards: string[],
  target: string
): { ok: boolean; value: number } {
  const s = String(expr ?? '').replace(/\s+/g, '');
  const tokens: Array<number | string> = [];
  const re = /\[(\d)\]|([-+*/()])/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return { ok: false, value: NaN };
    tokens.push(m[1] !== undefined ? Number(m[1]) : m[2]);
    i = re.lastIndex;
  }
  const used = cards.map(() => 0);
  for (const t of tokens) {
    if (typeof t === 'number') {
      if (t < 0 || t >= cards.length) return { ok: false, value: NaN };
      used[t]++;
    }
  }
  if (!used.every((u) => u === 1)) return { ok: false, value: NaN };
  const expanded = tokens
    .map((t) => (typeof t === 'number' ? `(${cards[t]})` : t))
    .join('');
  const val = evalArithTokens(expanded);
  const tgt = evalArithTokens(target);
  const ok = Number.isFinite(val) && Number.isFinite(tgt) && Math.abs(val - tgt) <= 1e-6;
  return { ok, value: val };
}

export function checkNumericItem(submitted: string, expected: string, tolerance = 1e-6): boolean {
  const s = String(submitted ?? '').trim();
  const e = String(expected ?? '').trim();
  if (!s) return false;
  if (s === e) return true;
  const sv = evalNumeric(s);
  const ev = evalNumeric(e);
  if (Number.isFinite(sv) && Number.isFinite(ev)) {
    return Math.abs(sv - ev) <= Math.max(tolerance, 1e-6);
  }
  return false;
}

export function gradeObjective(activity: Activity, value: unknown): boolean | null {
  switch (activity.type) {
    case 'single': {
      if (typeof value !== 'number' || !activity.correct) return null;
      return activity.correct.includes(value);
    }
    case 'multiple': {
      if (!Array.isArray(value) || !activity.correct) return null;
      const a = [...new Set(value.map(Number))].sort((x, y) => x - y);
      const b = [...new Set(activity.correct)].sort((x, y) => x - y);
      return a.length === b.length && a.every((v, idx) => v === b[idx]);
    }
    case 'numeric': {
      if (activity.items && Array.isArray(value)) {
        return activity.items.every((item, idx) =>
          checkNumericItem(String(value[idx] ?? ''), item.answer, activity.tolerance ?? 1e-6)
        );
      }
      if (activity.answer !== undefined && typeof value === 'string') {
        return checkNumericItem(value, activity.answer, activity.tolerance ?? 1e-6);
      }
      return null;
    }
    case 'make': {
      if (typeof value !== 'string' || !activity.cards) return false;
      return evalMakeExpression(value, activity.cards, activity.target ?? '0').ok;
    }
    case 'manipulate': {
      if (!value || typeof value !== 'object' || !('vars' in value)) return false;
      const vars = (value as { vars?: Record<string, number> }).vars ?? {};
      if (!activity.targetVars) return true;
      const tol = activity.tolerance ?? 0.05;
      return Object.entries(activity.targetVars).every(([k, tgt]) => {
        const actual = Number(vars[k]);
        return Number.isFinite(actual) && Math.abs(actual - tgt) <= tol;
      });
    }
    default:
      return null;
  }
}

export function buildAggregate(
  activity: Activity | undefined,
  latestAnswers: Answer[],
  totalStudents: number
): {
  submitted: number;
  total: number;
  correct?: number;
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const submitted = latestAnswers.length;
  if (!activity) return { submitted, total: totalStudents, counts };

  let correct = 0;
  let hasCorrectMetric = false;

  for (const ans of latestAnswers) {
    if (ans.correct !== null) hasCorrectMetric = true;
    if (ans.correct === true) correct++;

    const v = ans.value;
    if (activity.type === 'single' && typeof v === 'number') {
      const k = String(v);
      counts[k] = (counts[k] || 0) + 1;
    } else if (activity.type === 'multiple' && Array.isArray(v)) {
      for (const idx of v) {
        const k = String(idx);
        counts[k] = (counts[k] || 0) + 1;
      }
    } else if (activity.type === 'scale' && (typeof v === 'number' || typeof v === 'string')) {
      const k = String(v);
      counts[k] = (counts[k] || 0) + 1;
    } else if (activity.type === 'numeric' && activity.items && Array.isArray(v)) {
      activity.items.forEach((item, idx) => {
        if (checkNumericItem(String(v[idx] ?? ''), item.answer, activity.tolerance ?? 1e-6)) {
          const k = `item${idx}`;
          counts[k] = (counts[k] || 0) + 1;
        }
      });
    } else if (activity.type === 'numeric' && typeof v === 'string') {
      const n = evalNumeric(v);
      const k = Number.isFinite(n) ? String(+n.toFixed(6)) : v.trim() || '（空白）';
      counts[k] = (counts[k] || 0) + 1;
    } else if (activity.type === 'make' && typeof v === 'string') {
      counts[v] = (counts[v] || 0) + 1;
    } else if (activity.type === 'manipulate') {
      const k = ans.correct ? 'correct' : 'incorrect';
      counts[k] = (counts[k] || 0) + 1;
    }
  }

  return {
    submitted,
    total: totalStudents,
    ...(hasCorrectMetric ? { correct } : {}),
    counts,
  };
}
