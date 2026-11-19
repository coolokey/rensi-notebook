import { getEffectiveAiConfig, getSetting, setSetting } from './db';
import type {
  Activity,
  Answer,
  Env,
  Grade,
  Lesson,
  RedPenAnnotation,
} from './types';

function todayKey(): string {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return `ai_usage:${now.toISOString().slice(0, 10)}`;
}

export async function getAiUsedToday(db: D1Database): Promise<number> {
  const val = await getSetting<{ count: number }>(db, todayKey());
  return val?.count ?? 0;
}

async function incrementAiUsage(db: D1Database): Promise<number> {
  const cur = await getAiUsedToday(db);
  const next = cur + 1;
  await setSetting(db, todayKey(), { count: next });
  return next;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i++) {
    bin += String.fromCharCode(u8[i]);
  }
  return btoa(bin);
}

async function callLlm(
  env: Env,
  messages: Array<{
    role: 'system' | 'user';
    text: string;
    images?: Array<{ mime: string; base64: string }>;
  }>,
  maxTokens = 1600
): Promise<{ text: string; model: string }> {
  const cfg = await getEffectiveAiConfig(env);
  if (!cfg.configured) {
    throw new Error('尚未設定 AI API key');
  }
  const used = await getAiUsedToday(env.DB);
  if (used >= cfg.dailyLimit) {
    throw new Error(`今日 AI 呼叫已達上限（${cfg.dailyLimit} 次）`);
  }

  await incrementAiUsage(env.DB);

  if (cfg.provider === 'anthropic') {
    const sys = messages.find((m) => m.role === 'system')?.text || '';
    const userMsgs = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: 'user',
        content: [
          ...(m.images || []).map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mime, data: img.base64 },
          })),
          { type: 'text', text: m.text },
        ],
      }));
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        ...(sys ? { system: sys } : {}),
        messages: userMsgs,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API 錯誤 (${res.status}): ${(await res.text()).slice(0, 180)}`);
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return {
      text: data.content?.map((c) => c.text || '').join('\n') || '',
      model: cfg.model,
    };
  }

  // OpenAI & OpenAI-compatible (including Google Gemini OpenAI endpoint)
  const openAiMsgs = messages.map((m) => {
    if (!m.images?.length) {
      return { role: m.role, content: m.text };
    }
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.text },
        ...m.images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mime};base64,${img.base64}` },
        })),
      ],
    };
  });

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: openAiMsgs,
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    throw new Error(`AI API 錯誤 (${res.status}): ${(await res.text()).slice(0, 180)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return {
    text: data.choices?.[0]?.message?.content || '',
    model: cfg.model,
  };
}

function extractJsonBlock(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced ? fenced[1].trim() : text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 未回傳有效 JSON');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

export async function testAiConnection(env: Env): Promise<{
  ok: boolean;
  model?: string;
  reply?: string;
  ms?: number;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    const out = await callLlm(
      env,
      [
        {
          role: 'user',
          text: '請用繁體中文簡短回覆「連線成功」。',
        },
      ],
      60
    );
    return {
      ok: true,
      model: out.model,
      reply: out.text.trim().slice(0, 80),
      ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : '連線測試失敗',
    };
  }
}

export async function gradeAnswerWithAi(
  env: Env,
  params: {
    activity: Activity;
    answer: Answer;
    depth: 'verdict' | 'fast' | 'full';
  }
): Promise<Grade> {
  const { activity, answer, depth } = params;
  const criteria = activity.rubric?.criteria ?? [];
  const maxTotal = criteria.reduce((s, c) => s + c.points, 0) || 1;
  const val = answer.value as { text?: string; work?: string; imageId?: string } | string;
  const studentText = typeof val === 'string' ? val : val?.work || val?.text || '';
  const imageId = typeof val === 'object' && val ? val.imageId : undefined;

  const cfg = await getEffectiveAiConfig(env);

  if (!cfg.configured) {
    // High-quality deterministic mock grading for demonstration & offline practice
    const hasContent = studentText.trim().length > 0 || Boolean(imageId);
    const scores = criteria.map((c, idx) => ({
      criterionId: c.id,
      score: hasContent ? (idx === 0 ? c.points : Math.max(1, c.points - 1)) : 0,
      comment: hasContent ? '已展現主要概念，建議再補充關鍵推導細節。' : '尚未作答',
    }));
    const total = scores.reduce((s, x) => s + x.score, 0);
    const annotations: RedPenAnnotation[] =
      depth === 'full' && imageId
        ? [
            { mark: 'check', x: 0.72, y: 0.28, text: '思路正確' },
            { mark: 'underline', x: 0.18, y: 0.52, x2: 0.65, y2: 0.52, text: '可再補充說明' },
          ]
        : [];
    return {
      answerId: answer.id,
      activityId: answer.activityId,
      seat: answer.seat,
      depth,
      mode: 'mock',
      basis: depth === 'fast' && studentText ? 'text' : 'image',
      ...(depth === 'verdict' ? { correct: hasContent } : {}),
      scores,
      total: depth === 'verdict' ? (hasContent ? maxTotal : 0) : total,
      max: maxTotal,
      feedback: hasContent
        ? '【模擬批改】整體掌握核心觀念！建議於設定頁面填入 API key 即可啟用真人等級 AI 讀圖與紅筆批註。'
        : '尚未偵測到作答內容，請補充手寫或文字說明。',
      transcript: studentText || (imageId ? '（手寫作答圖片已接收）' : ''),
      annotations,
      confidence: 0.85,
      needsReview: false,
      released: false,
      gradedAt: Date.now(),
    };
  }

  // Live multimodal AI grading
  const images: Array<{ mime: string; base64: string }> = [];
  if (imageId && depth !== 'fast') {
    const row = await env.DB.prepare('SELECT r2_key, content_type FROM images WHERE id = ?')
      .bind(imageId)
      .first<{ r2_key: string; content_type: string }>();
    if (row) {
      const obj = await env.R2.get(row.r2_key);
      if (obj) {
        const buf = await obj.arrayBuffer();
        images.push({
          mime: row.content_type || 'image/jpeg',
          base64: arrayBufferToBase64(buf),
        });
      }
    }
  }

  const rubricDesc = criteria
    .map(
      (c) =>
        `- ${c.id}（${c.label}，滿分 ${c.points} 分）：` +
        c.levels.map((l) => `${l.score}分=${l.description}`).join(' / ')
    )
    .join('\n');

  const prompt = `你是國中「仁思手札」的專業批改老師，請根據題目與評量規準批改學生作答。
題目：${activity.prompt}
參考解答：${activity.rubric?.reference || '無'}
評量規準：
${rubricDesc || '無（請判斷對錯並給予 0 或 1 分）'}

學生文字作答：${studentText || '（無文字，請檢視圖片）'}

請僅輸出 JSON（繁體中文），格式如下：
{
  "correct": true,
  "transcript": "辨識出的手寫內容摘要",
  "scores": [{"criterionId": "規準id", "score": 數字, "comment": "簡短評語"}],
  "feedback": "給學生溫暖具體的一句話回饋（50字內）",
  "confidence": 0.9,
  "annotations": [
    {"mark": "check|cross|circle|underline", "x": 0.0~1.0, "y": 0.0~1.0, "x2": 0.0~1.0, "y2": 0.0~1.0, "text": "短紅筆標註"}
  ]
}`;

  const res = await callLlm(
    env,
    [{ role: 'user', text: prompt, images }],
    1200
  );

  const parsed = extractJsonBlock(res.text) as {
    correct?: boolean;
    transcript?: string;
    scores?: Array<{ criterionId: string; score: number; comment?: string }>;
    feedback?: string;
    confidence?: number;
    annotations?: RedPenAnnotation[];
  };

  const scores = criteria.map((c) => {
    const found = parsed.scores?.find((s) => s.criterionId === c.id);
    const sc = found ? Math.max(0, Math.min(c.points, Number(found.score) || 0)) : 0;
    return { criterionId: c.id, score: sc, comment: found?.comment || '' };
  });
  const total = scores.reduce((s, x) => s + x.score, 0);
  const conf = Number(parsed.confidence ?? 0.85);

  return {
    answerId: answer.id,
    activityId: answer.activityId,
    seat: answer.seat,
    depth,
    mode: 'live',
    basis: images.length ? 'image' : 'text',
    ...(depth === 'verdict' ? { correct: Boolean(parsed.correct) } : {}),
    scores,
    total,
    max: maxTotal,
    feedback: parsed.feedback || '已完成批改。',
    transcript: parsed.transcript || studentText,
    annotations: depth === 'full' ? parsed.annotations || [] : [],
    confidence: conf,
    needsReview: conf < 0.7,
    released: false,
    gradedAt: Date.now(),
  };
}

export async function generateLessonDraft(
  env: Env,
  params: {
    topic: string;
    pages?: string;
    duration?: number;
    text?: string;
    wishes?: string;
    images?: string[];
  }
): Promise<{ mode: 'live' | 'mock'; lesson?: Lesson; text?: string; error?: string }> {
  const cfg = await getEffectiveAiConfig(env);
  const id = `lesson-${crypto.randomUUID().slice(0, 8)}`;
  const duration = params.duration || 45;

  if (!cfg.configured) {
    const draft: Lesson = {
      schemaVersion: 1,
      id,
      title: params.topic,
      description: `依據「${params.topic}」生成的 8 階段認知科學課堂草稿（模擬骨架，可於編輯器微調或設定 AI 金鑰以自動生成完整題目）。`,
      subject: params.topic.includes('國文')
        ? '國文'
        : params.topic.includes('自然') || params.topic.includes('理化')
        ? '自然'
        : params.topic.includes('社會') || params.topic.includes('歷史')
        ? '社會'
        : '數學',
      duration,
      objectives: [`掌握「${params.topic}」的核心概念與推理方法`, '能透過具體案例辨析常見迷思並完成反思'],
      slides: [
        {
          id: 'phase-1-recall',
          phase: '提取練習',
          eyebrow: '01 / 喚起舊知識',
          title: `關於「${params.topic}」，你還記得什麼？`,
          body: params.text?.slice(0, 80) || '先從一個快速判斷題喚起記憶。',
          visual: 'cards',
          activity: {
            id: `${id}-q1`,
            type: 'single',
            prompt: `開始探究「${params.topic}」前，你對基礎概念的掌握如何？`,
            options: ['已完全掌握基礎', '記得大概輪廓', '需要快速複習一次', '完全沒聽過'],
            correct: [0],
          },
        },
        {
          id: 'phase-2-predict',
          phase: '預測',
          eyebrow: '02 / 先猜再驗證',
          title: '直覺判斷：下列哪個說法最合理？',
          body: '請先做出大膽預測，下一頁我們再一起檢驗。',
          activity: {
            id: `${id}-q2`,
            type: 'scale',
            prompt: '你對自己剛才的直覺預測有幾分把握？',
            min: 1,
            max: 5,
            minLabel: '純猜測',
            maxLabel: '很有把握',
          },
        },
        {
          id: 'phase-3-worked',
          phase: '工作範例',
          eyebrow: '03 / 關鍵脈絡拆解',
          title: `${params.topic} 核心步驟`,
          body: '將複雜知識拆成三個清晰步驟。',
          visual: 'steps',
          bullets: ['步驟一：辨識核心條件與問題目標', '步驟二：連結視覺化或文本線索', '步驟三：檢驗合理性並修正迷思'],
          activity: {
            id: `${id}-q3`,
            type: 'short',
            prompt: '請用自己的話總結上述步驟中最容易忽略的一個細節。',
            aiAllowed: true,
          },
        },
        {
          id: 'phase-4-error',
          phase: '錯誤分析',
          eyebrow: '04 / 手寫／拍照紅筆診斷',
          title: '動手寫出完整推論或筆記圖解',
          body: '可在畫布書寫，或寫在課本筆記上拍照上傳。',
          activity: {
            id: `${id}-q4`,
            type: 'canvas',
            prompt: `請寫下「${params.topic}」的一道例題解法或概念心智圖。`,
            allowPhoto: true,
            aiAllowed: true,
            rubric: {
              criteria: [
                {
                  id: 'clarity',
                  label: '步驟清晰且邏輯正確',
                  points: 3,
                  levels: [
                    { score: 3, description: '步驟完整、結論正確' },
                    { score: 2, description: '大方向正確但有小瑕疵' },
                    { score: 1, description: '僅寫出部分線索' },
                    { score: 0, description: '未作答或離題' },
                  ],
                },
              ],
              reference: '請教師核對教材內容並填入參考解答。',
            },
          },
        },
      ],
    };
    return { mode: 'mock', lesson: draft };
  }

  const images: Array<{ mime: string; base64: string }> = [];
  for (const dataUrl of (params.images || []).slice(0, 4)) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (m) images.push({ mime: m[1], base64: m[2] });
  }

  const prompt = `請為國中「仁思手札」互動課堂設計一份教材 JSON（schemaVersion 必須為 1）。
單元主題：${params.topic}
頁碼參考：${params.pages || '無'}
課堂時間：${duration} 分鐘
教師期望：${params.wishes || '遵循認知科學流程，含至少 1 題 canvas 手寫／拍照＋rubric'}
教材文字：
${params.text || '（請參閱附圖或依國中課綱知識編寫）'}

請依「提取練習 -> 預測 -> 具體操作/圖式連結 -> 工作範例 -> 錯誤分析(canvas+rubric) -> 自評/出場券」設計 4~6 頁 slides。
請只回傳合法 JSON 物件，id 請使用 "${id}"。`;

  try {
    const out = await callLlm(env, [{ role: 'user', text: prompt, images }], 3500);
    const parsed = extractJsonBlock(out.text) as Lesson;
    parsed.schemaVersion = 1;
    parsed.id = id;
    parsed.title = parsed.title || params.topic;
    parsed.subject = parsed.subject || '跨科探究';
    parsed.duration = parsed.duration || duration;
    return { mode: 'live', lesson: parsed };
  } catch (err) {
    return {
      mode: 'live',
      error: err instanceof Error ? err.message : '生成失敗',
    };
  }
}

export async function runAiAssistantTask(
  env: Env,
  params: {
    task: string;
    lesson?: Lesson | null;
    activity?: Activity | null;
    answers?: Answer[];
  }
): Promise<{ mode: 'live' | 'mock'; text: string }> {
  const cfg = await getEffectiveAiConfig(env);
  const { task, lesson, activity, answers = [] } = params;

  if (!cfg.configured) {
    if (task === 'response-summary') {
      return {
        mode: 'mock',
        text: `【模擬分析・尚未設定 API key】\n本次共收到 ${answers.length} 份作答。\n1. 建議先讓未作答同學在座號表確認送出。\n2. 針對「${activity?.prompt || '本題'}」，可抽籤邀請作答完整與有常見迷思的同學各 1 位上台分享對照。`,
      };
    }
    return {
      mode: 'mock',
      text: `【模擬教案檢視・尚未設定 API key】\n課程《${lesson?.title || '未命名'}》共 ${lesson?.slides.length || 0} 頁。\n- 建議檢核：每頁是否都有清晰的單一概念聚焦、畫布題皆已設定評量規準 (Rubric)。`,
    };
  }

  const prompt =
    task === 'response-summary'
      ? `請整理以下課堂 IRS 全班作答（題目：${activity?.prompt}），指出主要正確思路與常見迷思概念，並給老師 2 個課堂即時追問建議（繁體中文，250 字內）：\n${answers
          .slice(0, 40)
          .map((a) => `${a.seat}號: ${JSON.stringify(a.value)}`)
          .join('\n')}`
      : `請檢視這份國中課程教案的認知負荷與提問設計，給予 3 點具體教學建議（繁體中文，300 字內）：\n課程：${lesson?.title}\n目標：${lesson?.objectives?.join('；')}\n投影片標題：${lesson?.slides
          .map((s, i) => `${i + 1}. [${s.phase || ''}] ${s.title}`)
          .join('\n')}`;

  const out = await callLlm(env, [{ role: 'user', text: prompt }], 800);
  return { mode: 'live', text: out.text };
}

export async function runOcrTask(
  env: Env,
  params: { prompt?: string; dataUrl?: string; mockText?: string }
): Promise<{ text: string; mode: 'live' | 'mock' }> {
  if (params.mockText !== undefined) {
    return { text: params.mockText, mode: 'mock' };
  }
  const cfg = await getEffectiveAiConfig(env);
  if (!cfg.configured || !params.dataUrl) {
    return { text: '（手寫作答已儲存；設定 AI API key 后可自動轉寫文字）', mode: 'mock' };
  }
  const m = /^data:([^;]+);base64,(.+)$/.exec(params.dataUrl);
  if (!m) return { text: '', mode: 'mock' };
  const out = await callLlm(
    env,
    [
      {
        role: 'user',
        text: `請精準轉寫圖片中的學生手寫算式或文字（每行一條，純文字與數學符號即可）：`,
        images: [{ mime: m[1], base64: m[2] }],
      },
    ],
    600
  );
  return { text: out.text.trim(), mode: 'live' };
}
