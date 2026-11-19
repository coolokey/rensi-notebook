# 仁思手札 · Rensi Thinking Notebook

**「一頁一思考，落筆見真章。」**
為國中跨科互動教學（國文、數學、自然、社會）打造的 Cloudflare Workers 全端即時互動課堂系統，採用「日系清透紙感手帳」視覺風格與赤陶「仁」字印章識別。

## 核心功能

- **跨科認知科學投影片與可操作 SVG 圖形**：支援動態滑桿、座標圖形、函數繪圖與雙重編碼色彩對應。
- **逐頁 IRS 即時提問（8 種題型）**：單選、多選、自評量尺、短答、數值填答、手寫／拍照畫布、操作題、湊數挑戰。
- **評量規準 (Rubrics) 與朱砂紅筆 AI 批改**：支援 Gemini / OpenAI / Anthropic / 相容 API，未填金鑰時內建模擬批改與草稿生成，可直接演練完整課堂流程。
- **全班互動遊戲**：課後檢核、雙人 PK 戰、全班合作魔王戰（對應布魯姆記憶／理解／應用／分析）、原題補救練習與彈幕互動。
- **回家作業 QR Code 系統**：支援班級弱點統計派發、免登入學生作答網頁（`#/hw/:id/:seat/:token`）與教師端手動改判。

---

## 本機開發啟動

### 1. 安裝依賴
```bash
npm install
```

### 2. 套用本機 D1 資料庫 Migration
```bash
npm run db:migrate:local
```

### 3. 建置教材與前端資源並啟動本機伺服器
```bash
npm run dev
```

瀏覽器開啟 `http://127.0.0.1:8787/#/dashboard`：
- **預設教師帳號**：`teacher@rensi.edu`
- **預設密碼**：`11235813`（首次登入後系統會提醒修改密碼）
- **內建示範班級代碼**：`RENSI801`（預設免識別碼，座號 1～30 號可直接登入測試）

---

## 專案腳本

- `npm run lessons`：驗證 `content/lessons/*.json` 並生成 `src/catalog.generated.ts`
- `npm run build:frontend`：建置 `public/` 靜態網站與日系清透紙感主題樣式
- `npm run build`：同時驗證教材並建置前端
- `npm run typecheck`：TypeScript 型別檢查

---

## 部署至 Cloudflare Workers

### 1. 登入 Cloudflare
```bash
npx wrangler login
```

### 2. 建立遠端 D1 資料庫與 R2 儲存桶
```bash
npx wrangler d1 create rensi-db
npx wrangler r2 bucket create rensi-media
```
將 `wrangler d1 create rensi-db` 回傳的 `database_id` 填入 `wrangler.jsonc` 中的 `d1_databases[0].database_id`。

### 3. 套用遠端資料庫 Migration
```bash
npm run db:migrate:remote
```

### 4. 一鍵建置並部署
```bash
npm run deploy
```

> （選填）如需在部署環境預設啟用 AI 金鑰，可執行：
> `npx wrangler secret put AI_API_KEY`
> 也可在登入網站後進入「設定」頁面直接在網站介面儲存教師專屬 API key。

---

## 透過 GitHub 連動 Cloudflare Workers 部署

若想每次推送至 GitHub 後自動觸發 Cloudflare Workers Builds 部署，請先完成一次遠端 D1／R2 建立與 Migration，並將 `wrangler.jsonc` 中的 `database_id` 更新提交後，於 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository** 連結此 GitHub Repo：

- **Build command**：`npm run build`
- **Deploy command**：`npx wrangler deploy`

