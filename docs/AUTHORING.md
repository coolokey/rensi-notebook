# 仁思手札（Rensi Thinking Notebook）教材製作指南

本指南說明如何撰寫與驗證 `content/lessons/*.json` 專案教材。每一份教材皆以單一 JSON 檔案儲存，透過 `npm run lessons` 驗證格式後自動編譯進系統，並在教師總覽頁標示為「專案教材」。

## 1. 頂層結構（`schemaVersion: 1`）

```json
{
  "schemaVersion": 1,
  "id": "lesson-unique-id",
  "title": "課程名稱",
  "description": "課程簡介（建議 1~2 句）",
  "subject": "國文 | 數學 | 自然 | 社會 | 跨科探究",
  "duration": 45,
  "objectives": ["學習目標 1", "學習目標 2"],
  "slides": [ /* 投影片陣列 */ ],
  "quiz": {
    "topics": [
      {
        "topic": "題型名稱",
        "objective": "對應學習目標",
        "performance": ["學習表現代碼"],
        "variants": [
          {
            "stem": "題幹",
            "options": ["選項A", "選項B", "選項C", "選項D"],
            "answer": 0,
            "explanation": "解析說明"
          }
        ]
      }
    ]
  },
  "raid": {
    "section": "章節名稱",
    "title": "魔王戰主題",
    "pools": {
      "attack": [ /* 記憶題：普通攻擊 */ ],
      "shield": [ /* 理解題：防護罩 */ ],
      "ultimate": [ /* 應用題：大招 */ ],
      "analysis": [ /* 分析題：破盾裂痕 */ ]
    }
  }
}
```

## 2. 認知科學設計 8 階段建議

建議投影片 `phase` 循序採用：
1. **提取練習**：喚起先備知識（單選 / 數值）
2. **預測**：先猜再驗證，誘發迷思（單選 / 自評）
3. **具體操作**：拖拉滑桿或點選圖形觀察變化（`interactive` + `manipulate`）
4. **圖式連結**：雙重編碼（同色對應圖與文字/算式）
5. **工作範例**：`visual: "steps"` 逐步呈現推導或分析脈絡
6. **半完成範例**：褪除提示的實作練習（`numeric` / `short`）
7. **錯誤分析**：手寫／拍照畫布題（`canvas` 必附 `rubric`）
8. **綜合評量**：課後檢核（`quizPage: true`）或全班魔王戰（`raidPage: true`）

## 3. IRS 互動題型（`activity.type`）

- `single` / `multiple`：`options: string[]`，`correct: number[]`
- `scale`：`min`, `max`, `minLabel`, `maxLabel`
- `short`：`prompt`, `rubric`（建議）, `aiAllowed: true`
- `numeric`：`answer`（或 `items: [{ prompt, answer }]`），`tolerance`（可選），`unit`（可選）
- `make`：`cards: string[]`, `target: string`（湊數挑戰）
- `manipulate`：`prompt`, `record: string[]`, `targetVars?: Record<string, number>`, `tolerance?: number`, `checkExpr?: string`
- `canvas`：`prompt`, `allowPhoto?: boolean`, `rubric`（**必填**，含 `criteria` 陣列，每項有 `id`, `label`, `points`, `levels`）與 `aiAllowed: true`

## 4. 可操作 SVG 圖形（`interactive`）

- `view`: `{ xMin, xMax, yMin, yMax, grid?, axes?, aspect?: "equal" | "fill" }`
- `params`: `[{ id, label, min, max, step, value }]`
- `points`: 可拖曳控制點 `[{ id, x, y, label?, color?, minX?, maxX?, minY?, maxY? }]`
- `shapes`: 支援 `rect`, `circle`, `polygon`, `line`, `segment`, `function`, `angle`, `brace`, `text`, `point`
- `readouts`: 即時公式數值讀數 `[{ label, expr }]`

## 5. 驗證與建置

完成編輯後執行：

```bash
npm run lessons
```

若通過驗證，將自動生成 `src/catalog.generated.ts`。
