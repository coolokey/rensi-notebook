import {
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = join(ROOT, 'frontend-src');
const OUT_DIR = join(ROOT, 'public');
const ASSETS_DIR = join(OUT_DIR, 'assets');
const FONTS_DIR = join(ASSETS_DIR, 'fonts');
const KATEX_FONTS = join(ROOT, 'node_modules', 'katex', 'dist', 'fonts');

function replaceExact(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`前端建置失敗：找不到目標片段 [${label}]`);
  }
  return source.replaceAll(search, replacement);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(FONTS_DIR, { recursive: true });

// 1. 複製 KaTeX 字型
const fontFiles = readdirSync(KATEX_FONTS).filter((f) => /\.(woff2|woff|ttf)$/i.test(f));
if (fontFiles.length === 0) {
  throw new Error('找不到 KaTeX 字型檔案，請確認已執行 npm install');
}
for (const f of fontFiles) {
  copyFileSync(join(KATEX_FONTS, f), join(FONTS_DIR, f));
}

// 2. 處理基礎 CSS 的 KaTeX 字型路徑並輸出覆寫主題
const rawCss = readFileSync(join(SRC_DIR, 'app.bundle.css'), 'utf8');
const builtCss = rawCss.replace(
  /\/assets\/KaTeX_([A-Za-z0-9_]+-[A-Za-z]+)-[A-Za-z0-9_-]+\.(woff2|woff|ttf)/g,
  '/assets/fonts/KaTeX_$1.$2'
);
if (builtCss.includes('/assets/KaTeX_')) {
  throw new Error('CSS 仍有未改寫的 KaTeX 字型雜湊路徑');
}
writeFileSync(join(ASSETS_DIR, 'index.css'), builtCss, 'utf8');
copyFileSync(join(SRC_DIR, 'theme-rensi.css'), join(ASSETS_DIR, 'theme-rensi.css'));

// 3. 複製人物形象圖素
for (const img of ['mascot-teach.png', 'mascot-avatar.png', 'mascot-moto.png']) {
  copyFileSync(join(SRC_DIR, img), join(ASSETS_DIR, img));
}

// 4. 改寫前端 JS 品牌名稱、圖騰、跨科文案與人物插畫
let js = readFileSync(join(SRC_DIR, 'app.bundle.js'), 'utf8');

const heroOldStart = '<div class="hero-graph"><svg viewBox="0 0 400 300">';
const heroOldEnd = '</ul></section><section class="login-card">';
const startIdx = js.indexOf(heroOldStart);
const endIdx = js.indexOf(heroOldEnd);
if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
  throw new Error('找不到首頁 Hero 區段');
}
const heroOldBlock = js.slice(startIdx, endIdx + '</ul></section>'.length);

const heroNewBlock =
  `<div class="hero-graph">` +
  `<div class="hero-mascot-stage">` +
  `<span class="hero-note-tag t-sci">自然・實驗探究</span>` +
  `<span class="hero-note-tag t-lit">國文・文本思辨</span>` +
  `<span class="hero-note-tag t-math">數學・動態視覺</span>` +
  `<span class="hero-seal-stamp" aria-hidden="true">仁</span>` +
  `<img class="hero-mascot-img" src="/assets/mascot-teach.png" alt="游貿仁老師「專心聽！」形象人物">` +
  `</div></div>` +
  `<h1>一頁一思考，<br><span>落筆見真章。</span></h1>` +
  `<p>跨科互動探索、逐頁即時提問；學生手寫或拍照作答，依評量規準即時批改與朱砂紅筆回饋。</p>` +
  `<ul class="hero-points"><li>\${w(\`sliders\`)}跨科互動探究</li><li>\${w(\`chart\`)}每頁 IRS</li><li>\${w(\`stamp\`)}規準紅筆批改</li></ul></section>`;

const replacements = [
  ['品牌變數 cd', 'var sd=document.querySelector(`#app`),cd=`數感課堂`', 'var sd=document.querySelector(`#app`),cd=`仁思手札`'],
  [
    '英文副標',
    '<span class="brand-name">${cd}<small>MATH CLASSROOM KIT</small></span>',
    '<span class="brand-name">${cd}<small>RENSI THINKING NOTEBOOK</small></span>',
  ],
  [
    '赤陶「仁」印章圖示',
    'sigma:`<path d="M18 5H6l6 7-6 7h12"/>`',
    'sigma:`<path d="M8.5 5.2 5.2 11.4M7.4 9.2v9.6M11.6 9.3h7.2M10.4 16.9h8.6"/>`',
  ],
  ['首頁 Hero 視覺與標語', heroOldBlock, heroNewBlock],
  [
    '教師側邊欄頭像',
    '<span class="avatar">師</span>',
    '<span class="avatar avatar-img"><img src="/assets/mascot-avatar.png" alt="游貿仁老師"></span>',
  ],
  [
    '學生等候室形象人物',
    '<div class="waiting-graph" aria-hidden="true"><i></i><i></i><i></i><i></i></div>',
    '<div class="waiting-mascot"><img src="/assets/mascot-teach.png" alt="游貿仁老師歡迎入座"></div>',
  ],
  [
    '教師無題目頁提示',
    '<div class="quiet-moment">${w(`sigma`)}<h2>這一頁沒有題目</h2>',
    '<div class="quiet-moment"><img class="quiet-mascot" src="/assets/mascot-teach.png" alt="專心聽講"><h2>這一頁沒有題目</h2>',
  ],
  [
    '學生無題目頁提示',
    '<div class="quiet-moment">${w(`sigma`)}<h2>先看、先想</h2>',
    '<div class="quiet-moment"><img class="quiet-mascot" src="/assets/mascot-teach.png" alt="專心聽講"><h2>先看、先想</h2>',
  ],
  [
    '雲端模式徽章',
    'ld.mode===`cloudflare`?`Cloudflare 私人課堂`',
    'ld.mode===`cloudflare`?`仁思手札・雲端課堂`',
  ],
  [
    '教師帳號輸入提示',
    'placeholder="${ld.mode===`supabase`?`teacher@example.edu`:`你的 Cloudflare 帳號信箱`}"',
    'placeholder="teacher@rensi.edu"',
  ],
  ['預設課程科目', 'subject:`數學`', 'subject:`跨科探究`'],
  ['課程卡片預設科目', 'e.subject||`數學`', 'e.subject||`跨科`'],
  [
    'AI 轉課程範例提示',
    'placeholder="例如：八上 1-1 乘法公式・和的平方"',
    'placeholder="例如：國文《背影》細節探究、八上乘法公式、自然力與運動"',
  ],
];

for (const [label, target, rep] of replacements) {
  js = replaceExact(js, target, rep, label);
}

writeFileSync(join(ASSETS_DIR, 'index.js'), js, 'utf8');

// 5. 產生 public/index.html（含赤陶「仁」印章 Favicon）
const faviconSvg =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E" +
  "%3Crect width='24' height='24' rx='6' fill='%23D96B43'/%3E" +
  "%3Crect x='2' y='2' width='20' height='20' rx='4.5' fill='none' stroke='%23FAF8F4' stroke-opacity='0.4' stroke-width='1.1'/%3E" +
  "%3Cpath d='M8.5 5.2 5.2 11.4M7.4 9.2v9.6M11.6 9.3h7.2M10.4 16.9h8.6' fill='none' stroke='%23FAF8F4' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E" +
  "%3C/svg%3E";

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#E3ECE6">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="description" content="仁思手札（Rensi Thinking Notebook）：國中跨科互動探索、逐頁 IRS、手寫與拍照作答、依評量規準即時批改與朱砂紅筆回饋。">
  <link rel="icon" href="${faviconSvg}">
  <title>仁思手札 · Rensi Thinking Notebook</title>
  <link rel="stylesheet" href="/assets/index.css">
  <link rel="stylesheet" href="/assets/theme-rensi.css">
  <script type="module" src="/assets/index.js"></script>
</head>
<body>
  <div id="app"><div class="boot">仁思手札，展開中…</div></div>
  <div id="toast" role="status" aria-live="polite"></div>
  <div id="modal-root"></div>
</body>
</html>
`;
writeFileSync(join(OUT_DIR, 'index.html'), html, 'utf8');
console.log(
  `✓ 前端建置完成：${fontFiles.length} 個 KaTeX 字型、主題樣式與 ${replacements.length} 項品牌／形象人物替換已寫入 public/`
);
