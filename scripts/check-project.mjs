#!/usr/bin/env node
/*
 * 品質ゲート（GIGA Standard v5 §P4）
 *
 *   npm run check                               … 検査する
 *   node scripts/check-project.mjs --self-test  … 検査そのものが動くか確かめる
 *
 * ⚠️ 自己テストは飾りではない。「0件でした」だけでは、検査が動いているのか
 *    何も見ていないのか区別できない。この確認をしたことで、共通の検査そのものの
 *    不具合が何度も見つかっている。
 *
 * ## 構成
 *
 *   scripts/lib/giga-v5-checks.mjs … 共通の検査の【正本のコピー】。
 *     GIGAyama.github.io/standards/lib/ からのコピーで、ここでは手を入れない。
 *     直すときは正本を直してから配る（drift ジョブがずれを見張っている）。
 *   scripts/lib/local-checks.mjs   … このリポジトリだけの検査。
 *
 * かつてここに、共通の正本 scripts/lib/project-quality.mjs を「あれば合成、
 * 無ければ Part I の検査だけ」で読む枝があった。外した理由（2026-08-22 に実測）:
 * その正本は一度も取り込まれず、何の知らせも出さないまま素通りしていた。
 * 含まれていた秘密の直書きの検査も働かず、Google API キーと同じ形の文字列を
 * 置いても緑になっていた。しかも艦隊のどのコピーも、この枝が探す名前を
 * export していなかった。
 *
 * ## ビルドしてから走らせる
 *
 * このアプリは vite-plugin-pwa の injectManifest を使う。manifest も
 * 先読み一覧もビルド時に作られるので、原文だけでは真偽が決まらない。
 * dist が無ければ BUILD_PRESENT が落ちる（黙って素通りさせない）。
 */
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runGigaChecks } from './lib/giga-v5-checks.mjs';
import { runLocalChecks, runBuildChecks } from './lib/local-checks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'quality.config.json'), 'utf8'));

// 正本は { id, title, ok, detail(配列), skipped } を返す。ローカルは
// { id, ok, detail(文字列), severity }。出力をそろえてから並べる。
//
// ⚠️ 設定は「いま見ている木」から読む。外の config を使うと、自己確認で
//    quality.config.json を壊しても効かず、上限を見る検査（PRECACHE_BUDGET など）が
//    「壊したのに落ちない」ように見える。実際そうなっていた（2026-08-23）。
const collect = (root) => {
  const cfg = JSON.parse(readFileSync(join(root, 'quality.config.json'), 'utf8'));
  return [
  ...runGigaChecks(root, cfg.standard).map((r) => ({
    id: r.id,
    ok: r.ok,
    skipped: !!r.skipped,
    // 理由は title の末尾に付く。r.skipped は真偽値なので、そのまま出すと「true」になる。
    detail: r.skipped ? r.title : (r.detail || []).join(' / ') || r.title,
    severity: 'P1',
  })),
  ...runLocalChecks(root, cfg).map((r) => ({ ...r, skipped: false })),
  ...runBuildChecks(root, cfg).map((r) => ({ ...r, skipped: false })),
  ];
};

/*
 * わざと壊す一覧。
 * 「この壊し方をしたら、この検査が落ちるはず」を書いてある。
 * 落ちなければ、その検査は何も見ていない。
 */
const BREAKS = [
  {
    id: 'B_NO_CDN_CODE',
    file: 'index.html',
    apply: (s) => s.replace('</head>', '  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>\n  </head>'),
  },
  {
    id: 'D_VIEWPORT',
    file: 'index.html',
    apply: (s) => s.replace(', viewport-fit=cover', ''),
  },
  {
    id: 'D_VIEWPORT',
    file: 'index.html',
    apply: (s) => s.replace('initial-scale=1.0', 'initial-scale=1.0, user-scalable=no'),
  },
  {
    id: 'B_CSP',
    file: 'index.html',
    apply: (s) => s.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
  },
  {
    id: 'B_NO_INLINE_SCRIPT',
    file: 'index.html',
    apply: (s) => s.replace('</body>', '<script>window.x = 1;</script>\n</body>'),
  },
  {
    id: 'E_INSTALL_HOOK',
    file: 'index.html',
    apply: (s) => s.replace('<script src="./install-hook.js"></script>', ''),
  },
  {
    id: 'E3_INSTALL_HOOK_FILE',
    file: 'public/install-hook.js',
    remove: true,
  },
  {
    id: 'D_DVH',
    file: 'src/index.css',
    // ⚠️ 正本は「前後250文字に 100dvh があれば、古いブラウザ向けの正しい
    //    ひかえ」と見る。ひかえの無い 100vh を離れた場所に足す形で壊す。
    apply: (s) => `${s}\n.__selftest { height: 100vh; }\n`,
  },
  {
    id: 'D_SAFE_AREA',
    file: 'src/index.css',
    apply: (s) => s.replaceAll('safe-area-inset', 'REMOVED-inset'),
  },
  {
    id: 'D_FLUID_TYPE',
    file: 'src/index.css',
    apply: (s) => s.replace(/clamp\([^)]*\)/g, '18px'),
  },
  {
    id: 'D_REDUCED_MOTION',
    file: 'src/index.css',
    apply: (s) => s.replaceAll('prefers-reduced-motion', 'prefers-REMOVED'),
  },
  {
    id: 'D_FORCED_COLORS',
    file: 'src/index.css',
    apply: (s) => s.replaceAll('forced-colors', 'REMOVED-colors'),
  },
  {
    id: 'PRESENTATION_MODE',
    file: 'src/index.css',
    apply: (s) => s.replaceAll('.presentation', '.REMOVED-mode'),
  },
  {
    id: 'E_SW_CACHE_SCOPE',
    file: 'src/sw.js',
    // ⚠️ 「消す式」ではなく「startsWith で自アプリ分に絞る式があるか」を見る
    apply: (s) => s.replace(/\.startsWith\(CACHE_PREFIX\)/, ' !== null'),
  },
  {
    id: 'E_SW_NO_LOCALSTORAGE',
    file: 'src/sw.js',
    apply: (s) => `${s}\nself.addEventListener('sync', () => { localStorage.setItem('x', 1); });\n`,
  },
  {
    id: 'E_SW_NO_SKIP_WAITING_ON_INSTALL',
    file: 'src/sw.js',
    apply: (s) => s.replace("self.addEventListener('install',", "self.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('install',"),
  },
  {
    id: 'E_SW_VERSION_GENERATED',
    file: 'src/sw.js',
    apply: (s) => s.replace("const APP_VERSION = '__APP_VERSION__';", "const APP_VERSION = 'v4';"),
  },
  {
    id: 'E_SW_PRECACHE_OFFLINE',
    file: 'sw-build.config.json',
    apply: (s) => s.replace('"precacheManagedByPlugin": true', '"precacheManagedByPlugin": false'),
  },
  {
    id: 'E_OFFLINE_HTML',
    file: 'public/offline.html',
    remove: true,
  },
  {
    id: 'E_SW_UPDATE_PROMPT',
    file: 'src/pwa.js',
    // 「押されたか」の見はりを外す（名前を変えるだけでは落ちない）
    apply: (s) => s.replace(/\n\s*if \(!userAskedUpdate[^\n]*\n/, '\n'),
  },
  {
    id: 'C_NO_LS_CLEAR',
    file: 'src/pwa.js',
    apply: (s) => `${s}\nexport const reset = () => localStorage.clear();\n`,
  },
  {
    id: 'C_NO_POSTMESSAGE_STAR',
    file: 'src/pwa.js',
    apply: (s) => `${s}\nexport const send = (w) => w.postMessage({ a: 1 }, '*');\n`,
  },
  {
    id: 'STUDY_APP_VERSION',
    file: 'src/studySession.js',
    apply: (s) => s.replace(/APP_VERSION\s*=\s*'([^']*)'/, "APP_VERSION = '0.0.1'"),
  },
  {
    id: 'PRINT_SCROLL_CLIP',
    file: 'src/index.css',
    // 紙に刷るときの overflow: visible を外す（画面では気づけない壊れ方）
    apply: (s) => s.replace('overflow: visible !important;', 'color: black;'),
  },
  {
    id: 'FORCED_COLORS_PAIR',
    file: 'src/index.css',
    // 正解の受けだけ残し、まちがいの受けを外す。
    // ハイコントラストでは面の色が両方消えるので、片方だけでは差が消える。
    apply: (s) => s.replace(/\n  \.cell-wrong \{[\s\S]*?\n  \}\n/, '\n'),
  },
  {
    id: 'E10_OFFLINE_PRECACHED',
    file: 'dist/sw.js',
    // ビルド結果の先読み一覧から offline.html を外す
    apply: (s) => s.replace(/offline\.html/g, 'nothing-at-all.html'),
  },
  {
    id: 'PRECACHE_VENDOR',
    file: 'dist/sw.js',
    // 重い vendor（TensorFlow.js）が先読みに入ってしまった形
    apply: (s) => s.replace('"url":"', '"url":"assets/tfjs-core.js","revision":null},{"url":"', 1),
  },
  {
    id: 'PRECACHE_BUDGET',
    file: 'quality.config.json',
    // 上限を 1KB にすれば、いまの先読み量で必ず越える
    apply: (s) => s.replace('"precacheKB": 1024', '"precacheKB": 1'),
  },
  {
    id: 'BUILD_PRESENT',
    file: 'dist',
    removeDir: true,
  },
  {
    id: 'A_LICENSE',
    file: 'LICENSE',
    remove: true,
  },
  {
    id: 'A_DEPENDABOT',
    file: '.github/dependabot.yml',
    remove: true,
  },
  {
    id: 'A_DOCS',
    file: 'MANUAL.md',
    remove: true,
  },
];

const report = (results) => {
  const failed = results.filter((r) => !r.ok && !r.skipped);
  for (const r of results) {
    const mark = r.skipped ? '－' : r.ok ? '✅' : '❌';
    console.log(`${mark} [${r.severity}] ${r.id.padEnd(34)} ${r.detail}`);
  }
  console.log(`\n${results.length - failed.length} / ${results.length} 件が基準を満たしています。`);
  return failed;
};

const selfTest = () => {
  console.log('== 品質ゲートの自己確認 ==');
  console.log('ファイルをわざと壊した写しを作り、対応する検査が落ちることを確かめます。\n');

  const base = collect(ROOT);
  const baseFailed = base.filter((r) => !r.ok && !r.skipped);
  if (baseFailed.length) {
    console.log('⚠️ もとの状態で落ちている検査があります。先にそちらを直してください。');
    for (const r of baseFailed) console.log(`   ❌ ${r.id} ${r.detail}`);
    return 1;
  }

  let bad = 0;
  for (const brk of BREAKS) {
    const dir = mkdtempSync(join(tmpdir(), 'giga-selftest-'));
    try {
      // dist は消さずに写す。ビルド結果を見る検査が「もとの状態で落ちている」に
      // なってしまうため。
      cpSync(ROOT, dir, {
        recursive: true,
        filter: (src) => !/node_modules|\.git$|\.git\/|dev-dist/.test(src),
      });
      const target = join(dir, brk.file);
      if (brk.removeDir) {
        rmSync(target, { force: true, recursive: true });
      } else if (brk.remove) {
        rmSync(target, { force: true });
      } else {
        const before = readFileSync(target, 'utf8');
        const after = brk.apply(before);
        if (after === before) {
          console.log(`⚠️ ${brk.id.padEnd(34)} 壊し方が当たっていません（対象の文字列が見つからない）`);
          bad++;
          continue;
        }
        writeFileSync(target, after);
      }
      const results = collect(dir);
      const hit = results.find((r) => r.id === brk.id);
      if (!hit) {
        console.log(`⚠️ ${brk.id.padEnd(34)} そんな検査がありません`);
        bad++;
      } else if (hit.ok) {
        console.log(`❌ ${brk.id.padEnd(34)} 壊したのに落ちませんでした（この検査は何も見ていない）`);
        bad++;
      } else {
        console.log(`✅ ${brk.id.padEnd(34)} 壊したら落ちた`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${BREAKS.length - bad} / ${BREAKS.length} 件の検査が、壊したときに落ちることを確認しました。`);
  return bad === 0 ? 0 : 1;
};

if (process.argv.includes('--self-test')) {
  process.exit(selfTest());
}
console.log(`== GIGA Standard v5 品質ゲート（${config.standard.repoName}）==\n`);
process.exit(report(collect(ROOT)).length === 0 ? 0 : 1);
