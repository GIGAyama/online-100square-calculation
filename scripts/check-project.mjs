#!/usr/bin/env node
/*
 * 品質ゲート（GIGA Standard v5 §P4）
 *
 *   npm run check              … 検査する
 *   npm run check -- --self-test … 「わざと壊して」検査が実際に反応するか確かめる
 *
 * ⚠️ 自己テストは飾りではない。「0件でした」だけでは、検査が動いているのか
 *    何も見ていないのか区別できない。v5 の元になったロールアウトでは、この確認をして
 *    初めて共通の検査そのものの不具合が3件見つかっている。
 *
 * 構成の意図：Part I の検査は scripts/lib/giga-v5-checks.mjs に分けてある。
 * リポジトリ共通の品質ゲート（正本 scripts/lib/project-quality.mjs）が配られたら、
 * このファイルは両者を合成するだけになり、正本は丸ごと差し替えで受け取れる。
 */
import { readFileSync, existsSync, mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'quality.config.json'), 'utf8'));

const { runGigaChecks } = await import('./lib/giga-v5-checks.mjs');

/** 正本があれば合成する。無ければ Part I の検査だけで走る */
async function runAll(root) {
  const findings = runGigaChecks(root, cfg);
  const canon = join(ROOT, 'scripts/lib/project-quality.mjs');
  if (existsSync(canon)) {
    const mod = await import(pathToFileURL(canon).href);
    if (typeof mod.runProjectQuality === 'function') {
      findings.push(...(await mod.runProjectQuality(root, cfg)));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 自己テスト：わざと壊して、検査が反応することを確かめる
// ---------------------------------------------------------------------------
const BREAKAGES = [
  {
    id: 'CDN_EXEC',
    what: 'ブラウザ内 Babel を index.html に足す',
    apply: (dir) => patch(join(dir, 'index.html'), (s) =>
      s.replace('</head>', '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script></head>')),
  },
  {
    id: 'VIEWPORT_ZOOM',
    what: 'viewport に user-scalable=no を足す',
    apply: (dir) => patch(join(dir, 'index.html'), (s) =>
      s.replace('viewport-fit=cover', 'viewport-fit=cover, user-scalable=no')),
  },
  {
    id: 'VIEWPORT_100VH',
    what: '@supports の外で 100vh を使う',
    apply: (dir) => patch(join(dir, 'src/index.css'), (s) => s + '\n.oops { height: 100vh; }\n'),
  },
  {
    id: 'RT_COLOR',
    what: 'rt の色を決め打ちする（継がせる受けも消す）',
    apply: (dir) => patch(join(dir, 'src/index.css'), (s) =>
      s.replace(/button rt,[\s\S]*?color: inherit;\n}/, '') + '\n.x rt { color: #666; }\n'),
  },
  {
    id: 'REDUCED_MOTION_ZERO',
    what: 'prefers-reduced-motion の .01ms を 0 にする',
    apply: (dir) => patch(join(dir, 'src/index.css'), (s) =>
      s.replace(/animation-duration: \.01ms/, 'animation-duration: 0ms')),
  },
  {
    id: 'FORCED_COLORS_PAIR',
    what: 'forced-colors の受けを「正解」だけにして、まちがいを外す',
    apply: (dir) => patch(join(dir, 'src/index.css'), (s) =>
      s.replace(/\n\s*\.cell-wrong \{\n\s*outline: 3px dashed CanvasText[^}]*\}/, '')),
  },
  {
    id: 'PRESENTATION_MODE',
    what: '提示モード（.presentation）を消す',
    apply: (dir) => patch(join(dir, 'src/index.css'), (s) => s.replace(/\.presentation\b/g, '.pres-x')),
  },
  {
    id: 'PRINT_SCROLL_CLIP',
    what: '@media print の overflow の戻しを消す（紙で表が切れる形にする）',
    apply: (dir) => patch(join(dir, 'src/index.css'), (s) =>
      s.replace(/\n\s*\.scroll-area \{\n\s*overflow: visible !important;\n\s*\}/, '')),
  },
  {
    id: 'SW_CACHE_WIPE',
    what: 'sw.js の startsWith による絞り込みを外す（削除式は残す）',
    apply: (dir) => patch(join(dir, 'src/sw.js'), (s) =>
      s.replace(/\.filter\(\(k\) => k\.startsWith[^\n]*\n/, '\n')),
  },
  {
    id: 'SW_LOCALSTORAGE',
    what: 'sw.js から localStorage を触る',
    apply: (dir) => patch(join(dir, 'src/sw.js'), (s) => s + '\nlocalStorage.setItem("x", "1");\n'),
  },
  {
    id: 'SW_SKIP_WAITING',
    what: 'sw.js の install で skipWaiting する',
    apply: (dir) => patch(join(dir, 'src/sw.js'), (s) =>
      s.replace("self.addEventListener('install', (e) => e.waitUntil((async () => {",
        "self.addEventListener('install', (e) => e.waitUntil((async () => {\n  self.skipWaiting();")),
  },
  {
    id: 'SW_APP_VERSION',
    what: 'APP_VERSION を上げ忘れる',
    apply: (dir) => patch(join(dir, 'package.json'), (s) => s.replace(/"version": "[^"]+"/, '"version": "9.9.9"')),
  },
  {
    id: 'MANIFEST_PATH',
    what: 'manifest の start_url を "./" に戻す',
    apply: (dir) => patch(join(dir, 'vite.config.js'), (s) =>
      s.replace(/start_url: '[^']*'/, "start_url: './'")),
  },
  {
    id: 'CSP_UNSAFE_INLINE',
    what: "script-src に 'unsafe-inline' を足す",
    apply: (dir) => patch(join(dir, 'index.html'), (s) =>
      s.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")),
  },
  {
    id: 'CSP_FRAME_ANCESTORS',
    what: 'frame-ancestors を <meta> に書く',
    apply: (dir) => patch(join(dir, 'index.html'), (s) =>
      s.replace("object-src 'none';", "object-src 'none'; frame-ancestors 'none';")),
  },
  {
    id: 'INSTALL_HOOK',
    what: 'install-hook.js の読み込みを <head> の後ろへ動かす',
    apply: (dir) => patch(join(dir, 'index.html'), (s) =>
      s.replace('<script src="/online-100square-calculation/install-hook.js"></script>', '')
        .replace('</head>', '<script src="/online-100square-calculation/install-hook.js"></script></head>')),
  },
  {
    id: 'LOCALSTORAGE_CLEAR',
    what: 'localStorage.clear() を呼ぶ',
    apply: (dir) => patch(join(dir, 'src/studyStats.js'), (s) => s + '\nexport const nuke = () => localStorage.clear();\n'),
  },
  {
    id: 'APPLE_TOUCH_ICON',
    what: 'apple-touch-icon を透明を含む画像に差し替える',
    apply: (dir) => cpSync(join(dir, 'public/favicon.png'), join(dir, 'public/apple-touch-icon.png')),
  },
  {
    id: 'LEGAL_MISSING',
    what: 'LICENSE を消す',
    apply: (dir) => patch(join(dir, 'package.json'), (s) => s, () => {
      writeFileSync(join(dir, 'LICENSE'), '');
    }, join(dir, 'LICENSE')),
  },
];

function patch(file, fn) {
  writeFileSync(file, fn(readFileSync(file, 'utf8')));
}

async function selfTest() {
  const { rmSync, unlinkSync } = await import('node:fs');
  console.log('🔧 自己テスト：わざと壊して、検査が反応するかを見る\n');
  let bad = 0;
  for (const b of BREAKAGES) {
    const dir = mkdtempSync(join(tmpdir(), 'giga-check-'));
    cpSync(ROOT, dir, {
      recursive: true,
      filter: (src) => !/node_modules|[/\\]\.git[/\\]?$|[/\\]dist([/\\]|$)/.test(src),
    });
    if (b.id === 'LEGAL_MISSING') unlinkSync(join(dir, 'LICENSE'));
    else b.apply(dir);

    const found = (await runAll(dir)).some((f) => f.id === b.id);
    console.log(`  ${found ? '✅' : '❌'} ${b.id.padEnd(22)} ${b.what}`);
    if (!found) bad++;
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${bad === 0 ? '✅ 検査はすべて反応した' : `❌ ${bad}件の検査が反応しなかった（検査自体の不具合）`}`);
  return bad === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let code = 0;

if (args.includes('--self-test')) {
  code = await selfTest();
} else {
  const findings = await runAll(ROOT);
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (findings.length === 0) {
    console.log('✅ GIGA Standard v5 品質ゲート：指摘なし');
  } else {
    for (const f of errors) console.log(`❌ [${f.id}] ${f.message}`);
    for (const f of warns) console.log(`⚠️  [${f.id}] ${f.message}`);
    console.log(`\nエラー ${errors.length}件 / 注意 ${warns.length}件`);
  }
  console.log('\nヒント: 検査そのものが動いているかは `npm run check -- --self-test` で確かめられます。');
  code = errors.length > 0 ? 1 : 0;
}

process.exit(code);
