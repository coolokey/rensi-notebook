export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  R2: R2Bucket;
  CLASSROOM_HUB: DurableObjectNamespace;
  DEFAULT_TEACHER_ACCOUNT: string;
  DEFAULT_TEACHER_NAME: string;
  SITE_NAME: string;
  AI_PROVIDER?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_API_KEY?: string;
}

export interface User {
  id: string;
  role: 'teacher' | 'student';
  name: string;
  account?: string;
  classId?: string;
  className?: string;
  classCode?: string;
  seat?: number;
}

export interface RubricLevel {
  score: number;
  description: string;
}

export interface RubricCriterion {
  id: string;
  label: string;
  points: number;
  levels: RubricLevel[];
}

export interface Rubric {
  criteria: RubricCriterion[];
  reference?: string;
}

export interface NumericItem {
  prompt: string;
  answer: string;
}

export interface Activity {
  id: string;
  type:
    | 'single'
    | 'multiple'
    | 'scale'
    | 'short'
    | 'numeric'
    | 'canvas'
    | 'manipulate'
    | 'make';
  prompt: string;
  options?: string[];
  correct?: number[];
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
  answer?: string;
  tolerance?: number;
  unit?: string;
  form?: string;
  items?: NumericItem[];
  cards?: string[];
  target?: string;
  record?: string[];
  targetVars?: Record<string, number>;
  checkExpr?: string;
  allowPhoto?: boolean;
  photoWork?: boolean;
  aiAllowed?: boolean;
  canvas?: string;
  explanation?: string;
  rubric?: Rubric;
}

export interface Slide {
  id: string;
  phase?: string;
  eyebrow?: string;
  title: string;
  body?: string;
  visual?: 'cards' | 'steps' | 'bars';
  bullets?: string[];
  source?: string;
  fullSlide?: boolean;
  customHtml?: string;
  interactive?: {
    caption?: string;
    view: {
      xMin: number;
      xMax: number;
      yMin: number;
      yMax: number;
      grid?: number;
      axes?: boolean;
      aspect?: 'equal' | 'fill';
    };
    params?: Array<{ id: string; label: string; min: number; max: number; step: number; value: number }>;
    points?: Array<{ id: string; x: number; y: number; label?: string; color?: string }>;
    shapes: Array<Record<string, unknown>>;
    readouts?: Array<{ label: string; expr: string }>;
    steps?: Array<{ label?: string; caption?: string }>;
    toggles?: Array<{ id: string; label: string; value?: boolean }>;
  };
  figures?: Array<{ src: string; alt?: string; caption?: string }>;
  animation?: { src?: string; poster?: string; seconds?: number; caption?: string; locked?: boolean };
  activity?: Activity;
  quizPage?: boolean;
  raidPage?: boolean;
  duelPage?: boolean;
  notes?: string;
}

export interface QuizVariant {
  stem: string;
  options: string[];
  answer: number;
  explanation?: string;
  figure?: string;
}

export interface QuizTopic {
  topic: string;
  objective: string;
  performance: string[];
  variants: QuizVariant[];
}

export interface RaidQuestion {
  id: string;
  kind: 'attack' | 'shield' | 'ultimate' | 'analysis';
  stem: string;
  options: string[];
  answer: number;
  reason?: string[];
  reasonAnswer?: number;
  hint?: string;
  explanation?: string;
  figure?: string;
}

export interface Lesson {
  schemaVersion: 1;
  id: string;
  title: string;
  description: string;
  subject: string;
  duration: number;
  objectives?: string[];
  slides: Slide[];
  quiz?: { topics: QuizTopic[] };
  raid?: {
    section?: string;
    title: string;
    pools: {
      attack: RaidQuestion[];
      shield: RaidQuestion[];
      ultimate: RaidQuestion[];
      analysis?: RaidQuestion[];
    };
  };
  duel?: {
    title: string;
  };
}

export interface Classroom {
  id: string;
  name: string;
  code: string;
  seats: number;
  requireCode: boolean;
  createdAt: number;
}

export interface Answer {
  id: string;
  userId?: string;
  sessionId: string;
  activityId: string;
  seat: number;
  attempt: number;
  value: unknown;
  correct: boolean | null;
  createdAt: number;
}

export interface RedPenAnnotation {
  mark: 'check' | 'cross' | 'question' | 'circle' | 'underline' | 'arrow';
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  text?: string;
}

export interface Grade {
  answerId: string;
  activityId: string;
  seat: number;
  depth: 'verdict' | 'fast' | 'full';
  mode: 'live' | 'mock' | 'teacher';
  basis?: 'text' | 'image';
  correct?: boolean;
  scores: Array<{ criterionId: string; score: number; comment?: string }>;
  total: number;
  max: number;
  feedback?: string;
  transcript?: string;
  annotations?: RedPenAnnotation[];
  marks?: Array<{ line: number; kind: string; note?: string }>;
  confidence?: number;
  needsReview?: boolean;
  votes?: number[];
  released: boolean;
  gradedAt: number;
}

export interface DanmakuItem {
  id: string;
  seat: number;
  text: string;
  anon: boolean;
  at: number;
}

export interface SessionState {
  id: string;
  classId: string;
  lessonId: string;
  title: string;
  className: string;
  slideIndex: number;
  activityOpen: boolean;
  activityDeadline: number | null;
  resultsVisible: boolean;
  followTeacher: boolean;
  ended: boolean;
  revision: number;
  drawnSeat: number | null;
  drawFilter: string;
  buzzOpen: boolean;
  buzzWinner: { seat: number; at: number } | null;
  danmakuOpen: boolean;
  danmakuClearedAt: number;
  photoOpen: boolean;
  whiteboard: Record<string, unknown[]>;
  practice: {
    id: string;
    activityId: string;
    startedAt: number;
    seconds: number;
    rounds: number;
    retry?: boolean;
    entries: Array<{
      seat: number;
      items?: number[];
      rounds: Array<{ round: number; startedAt: number; deadline: number; outcome?: string; value?: string }>;
    }>;
    prompts: string[];
    reveals: Array<{ round: number; answer: string; explanation?: string }>;
  } | null;
  quiz: Record<string, unknown> | null;
  pkLobby: {
    pairs: [number, number][];
    waiting: number | null;
    buzz: boolean;
  } | null;
  raid: Record<string, unknown> | null;
  duel: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface AiSettings {
  provider: 'openai' | 'gemini' | 'anthropic' | 'custom';
  baseUrl: string;
  model: string;
  apiKey?: string;
  dailyLimit: number;
}
