/*
 * GIGA Standard v5 Part I の検査（この1本にまとめてある）
 *
 * この分け方には理由がある。v5 §P4 は、リポジトリ共通の品質ゲート（正本）と
 * Part I の検査を別ファイルに分け、`check-project.mjs` が両者を合成する形を求めている。
 * こうしておくと、正本が更新されたときに「丸ごと差し替え」で受け取れる。
 * このリポジトリにはまだ正本（scripts/lib/project-quality.mjs）が置かれていないため、
 * check-project.mjs は「あれば読む」形にしてある。
 *
 * ⚠️ 検査そのものが動いているかは、`npm run check -- --self-test` で確かめる。
 *    「0件でした」だけでは、検査が動いているのか何も見ていないのか区別できない。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

/** コメントを落とす。注意書きに反応して誤検知するのを防ぐ（§P4 の実例） */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

// 検査の対象は「ブラウザへ届くもの」。dist は別枠で見る。
// scripts/ は検査そのもののコードで、壊れ方の見本を文字列として持っているため、
// ここへ含めると自分自身に反応してしまう
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'scripts']);

/**
 * `@supports not (… dvh …) { … }` のブロックを中括弧ごと取り除く。
 * 中身の 100vh は正しいフォールバックなので、検査の対象から外す。
 */
export function stripDvhFallbacks(src) {
  const re = /@supports\s+not\s*\([^)]*dvh[^)]*\)\s*\{/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    out += src.slice(last, m.index);
    // 対応する } を数えて閉じる
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    last = i;
    re.lastIndex = i;
  }
  return out + src.slice(last);
}

/**
 * `@media (…条件…) { … }` のブロックを、中括弧を数えて丸ごと取り出す。
 * 正規表現で `}` まで取ると、入れ子の規則で途中打ち切りになる。
 */
export function mediaBlocks(src, conditionRe) {
  const re = new RegExp(`@media[^{]*${conditionRe.source}[^{]*\\{`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** セレクタ部分に現れるクラス名を拾う（宣言の中身は見ない） */
const classNamesInSelectors = (css) => {
  const names = new Set();
  // `{` の直前までをセレクタとみなす
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    for (const c of m[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) names.add(c[1]);
  }
  return names;
};

/**
 * 「面や文字の色そのもので意味を伝えているクラス」を拾う。
 * ⚠️ 接頭辞が同じというだけで対にすると、`.cell-error-flash`（動きだけを付ける規則）まで
 *    仲間に数えてしまう。実際に誤検知した。色を宣言しているかどうかまで見る。
 */
const colorCarryingClasses = (css) => {
  const names = new Set();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|[\s;])(background-color|background|color)\s*:/.test(m[2])) continue;
    for (const c of m[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) names.add(c[1]);
  }
  return names;
};

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/**
 * PNG に「実際に透明な画素があるか」を、外部ライブラリ無しで判定する。
 * 色タイプ 4/6 はアルファチャンネルつき。3（パレット）は tRNS チャンクを見る。
 * ⚠️ 「アルファチャンネルがある」と「透明な画素がある」は別。ここでは
 *    パレットの tRNS に 255 未満が含まれるかまで見る。
 */
export function pngAlphaInfo(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) return { ok: false };
  const colorType = buf[25];
  let hasTransparent = colorType === 4 || colorType === 6;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'tRNS') {
      const data = buf.subarray(off + 8, off + 8 + len);
      if (colorType === 3) hasTransparent = data.some((v) => v < 255);
      else hasTransparent = true;
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return { ok: true, colorType, hasTransparent };
}

/**
 * @returns {{id:string, level:'error'|'warn', message:string}[]}
 */
export function runGigaChecks(root, cfg) {
  const fail = [];
  const add = (id, message, level = 'error') => fail.push({ id, level, message });

  const files = walk(root);
  const srcFiles = files.filter((f) => ['.js', '.jsx', '.mjs', '.ts', '.tsx', '.css', '.html'].includes(extname(f)));
  const htmlFiles = files.filter((f) => extname(f) === '.html');
  const pkg = JSON.parse(read(join(root, 'package.json')) || '{}');

  // ---- A. 法務・配布 ----
  for (const f of cfg.requiredFiles) {
    if (!existsSync(join(root, f))) add('LEGAL_MISSING', `${f} が無い`);
  }

  // ---- B6. CDN から取る実行コードは 0 バイト（v5 の最重要） ----
  // ブラウザへ送られるものだけを見る。ビルド設定やドキュメントの URL は対象外
  for (const f of [...htmlFiles, ...srcFiles.filter((s) => /\/src\//.test(s))]) {
    const body = stripComments(read(f) || '');
    for (const pat of cfg.forbiddenCdn) {
      if (body.includes(pat)) {
        add('CDN_EXEC', `${f.replace(root + '/', '')}: 実行コードを CDN から読んでいる（${pat}）。学校のフィルタリングで塞がれると起動しない`);
      }
    }
  }

  // ---- D1/D14. viewport ----
  for (const f of htmlFiles) {
    const body = read(f) || '';
    const m = body.match(/<meta[^>]*name=["']viewport["'][^>]*>/i);
    if (!m) continue;
    if (!/viewport-fit=cover/.test(m[0])) add('VIEWPORT_FIT', `${f.replace(root + '/', '')}: viewport に viewport-fit=cover が無い`);
    if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(m[0])) {
      add('VIEWPORT_ZOOM', `${f.replace(root + '/', '')}: 拡大を禁止している。見えづらい子が拡大できない害のほうが大きい`);
    }
  }

  // ---- D2. 100vh の単独使用 ----
  // ⚠️ @supports not (height: 100dvh) { … 100vh } は正しいフォールバックなので通す。
  //    ここは実際に取りこぼした。@supports で split して先頭ブロックだけを見る書き方だと、
  //    @supports より「後ろ」に書かれた 100vh が最後のブロックに入って見えなくなる。
  //    フォールバックの中括弧ごと取り除いてから、残りに 100vh があるかを見るのが正しい。
  for (const f of srcFiles) {
    const body = stripComments(read(f) || '');
    if (!/100vh/.test(body)) continue;
    if (/100vh/.test(stripDvhFallbacks(body))) {
      add('VIEWPORT_100VH', `${f.replace(root + '/', '')}: 100vh を dvh のフォールバック外で使っている`);
    }
  }

  // ---- D3. safe-area ----
  if (!srcFiles.some((f) => /safe-area-inset/.test(read(f) || ''))) {
    add('SAFE_AREA', 'safe-area-inset をどこでも使っていない');
  }

  // ---- D10. prefers-reduced-motion（.01ms であって 0 でない） ----
  const motionFiles = srcFiles.filter((f) => /prefers-reduced-motion/.test(read(f) || ''));
  if (motionFiles.length === 0) add('REDUCED_MOTION', 'prefers-reduced-motion に対応していない');
  for (const f of motionFiles) {
    const body = stripComments(read(f) || '');
    const block = body.slice(body.indexOf('prefers-reduced-motion'));
    if (/animation-duration:\s*0m?s/.test(block) || /transition-duration:\s*0m?s/.test(block)) {
      add('REDUCED_MOTION_ZERO', `${f.replace(root + '/', '')}: 0 にすると fill-mode: forwards が壊れ、要素が opacity:0 のまま消える。.01ms にする`);
    }
  }

  // ---- D11. forced-colors ----
  if (!srcFiles.some((f) => /forced-colors/.test(read(f) || ''))) {
    add('FORCED_COLORS', 'forced-colors（ハイコントラストモード）に対応していない');
  }

  // ---- D11. forced-colors の受けが「片方だけ」になっていないか ----
  //
  // ⚠️ 対になる状態（正解／まちがい、選択中／未選択）は、片方だけ受けると
  //    誰も気づけない形で壊れる。ハイコントラストでは面の色が両方とも
  //    消えるため、正解にだけ枠を足すと「まちがい」が「未回答」と
  //    まったく同じ見た目になる。実際にそうなっていた（比較対象が無いので
  //    スクリーンショットを見ても違和感が出ない）。
  //
  //    見るべきは「forced-colors で受けているクラスと同じ接頭辞を持つ
  //    仲間のクラスが、自分のスタイルシートに定義されているのに受けていないか」。
  {
    const allCss = srcFiles.map((f) => stripComments(read(f) || '')).join('\n');
    const received = new Set();
    for (const block of mediaBlocks(allCss, /forced-colors/)) {
      for (const n of classNamesInSelectors(block)) received.add(n);
    }
    // 自分のスタイルシートが「色で意味を伝えている」クラス
    // （Tailwind の実用クラスは自分では定義していないので対象外）
    const carriers = colorCarryingClasses(allCss);
    const seen = new Set();
    for (const name of received) {
      const i = name.lastIndexOf('-');
      if (i <= 0) continue;
      const prefix = name.slice(0, i + 1);
      for (const other of carriers) {
        if (other === name || received.has(other) || !other.startsWith(prefix)) continue;
        if (seen.has(other)) continue;
        seen.add(other);
        add('FORCED_COLORS_PAIR', `.${other} が forced-colors で受けられていない（.${name} は受けている）。ハイコントラストでは面の色が両方とも消えるため、片方だけ手当てすると差が消える`);
      }
    }
  }

  // ---- D12. 提示モード（一斉授業で使うアプリには必ず用意する §2-11） ----
  if (cfg.presentationMode !== false
    && !srcFiles.some((f) => /\.presentation\b/.test(stripComments(read(f) || '')))) {
    add('PRESENTATION_MODE', '提示モード（.presentation）が無い。電子黒板に映したとき、教室のうしろの席から読めない');
  }

  // ---- D13. 紙には横スクロールが無い ----
  //
  // ⚠️ 画面では overflow-x: auto が「はみ出したら横スクロール」だが、
  //    紙にはスクロールが無いので、はみ出した分はそのまま切り取られる。
  //    実測では A4 縦に刷った 100マスの 10 列目が 3.5mm 切れていた。
  //    画面を見ているだけでは絶対に気づけない。
  //
  // ⚠️ ファイルごとに見てはいけない。スクロールさせているのは JSX 側の
  //    Tailwind クラス（overflow-x-auto）で、@media print はスタイルシートにある。
  //    別々のファイルなので、1ファイルずつ見ると永久に一致せず、検査が
  //    「何も見ていないのに通る」状態になる。実際にそうなっていた。
  {
    const all = srcFiles.map((f) => stripComments(read(f) || '')).join('\n');
    const printBlocks = mediaBlocks(all, /print/);
    const scrolls = /overflow(-[xy])?\s*:\s*(auto|scroll)/.test(all)
      || /\boverflow(-[xy])?-(auto|scroll)\b/.test(all);   // Tailwind の実用クラス
    if (printBlocks.length > 0 && scrolls && !printBlocks.some((b) => /overflow/.test(b))) {
      add('PRINT_SCROLL_CLIP', 'overflow: auto でスクロールさせているのに、@media print で戻していない。紙には横スクロールが無いので、はみ出した分はそのまま切り取られる');
    }
  }

  // ---- F4. rt の色を決め打ちしていないか ----
  for (const f of srcFiles) {
    const body = stripComments(read(f) || '');
    if (!/(^|[\s,{}])rt\s*\{/.test(body)) continue;
    // 色を決め打ちしていても、色のついた面で継がせる受けがあれば良い
    const inherits = /rt\s*\{[^}]*color:\s*inherit/.test(body) || /rt\s*,?[^{]*\{\s*color:\s*inherit/.test(body);
    const fixed = /rt\s*\{[^}]*color:\s*(#|rgb|hsl|oklch)/.test(body);
    if (fixed && !inherits) {
      add('RT_COLOR', `${f.replace(root + '/', '')}: rt の色を決め打ちしている。色のついたボタンの上で読めなくなる（ふりがなが要るのは低学年の児童）`);
    }
  }

  // ---- C5. localStorage.clear() ----
  for (const f of srcFiles) {
    if (/localStorage\s*\.\s*clear\s*\(/.test(stripComments(read(f) || ''))) {
      add('LOCALSTORAGE_CLEAR', `${f.replace(root + '/', '')}: localStorage.clear() は他アプリと共有している学習ログまで消す`);
    }
  }

  // ---- E. Service Worker ----
  const swPath = [join(root, 'src/sw.js'), join(root, 'public/sw.js'), join(root, 'sw.js')].find(existsSync);
  if (!swPath) {
    add('SW_MISSING', 'sw.js が見つからない');
  } else {
    const raw = read(swPath);
    const sw = stripComments(raw);

    // ⚠️ 「消す式」を正規表現で追うと (k) => caches.delete(k) を見落とす。
    //    見るべきは「startsWith で自アプリ分に絞る式があるか」（§P4）
    if (/caches\.keys\s*\(/.test(sw) && !/startsWith\s*\(/.test(sw)) {
      add('SW_CACHE_WIPE', 'sw.js が caches.keys() を自アプリ接頭辞で絞っていない。同一オリジンの他アプリがオフラインで起動しなくなる');
    }

    // ⚠️ 「localStorage は操作しない」という注意書きに反応しないよう、コメントを落として判定
    if (/localStorage/.test(sw)) add('SW_LOCALSTORAGE', 'sw.js が localStorage に触れている');

    // install の中で skipWaiting すると、児童の操作中に画面が入れ替わる
    const installBlock = sw.slice(sw.indexOf("'install'"), sw.indexOf("'activate'"));
    if (/skipWaiting/.test(installBlock)) {
      add('SW_SKIP_WAITING', "sw.js の install で skipWaiting している。計算の途中で入れ替わり、打ちかけの答えとタイムが消える");
    }

    // E11. APP_VERSION が package.json の版と揃っているか（上げ忘れ対策）
    const v = raw.match(/APP_VERSION\s*=\s*['"]v?([^'"]+)['"]/);
    if (!v) add('SW_APP_VERSION', 'sw.js に APP_VERSION が無い');
    else if (pkg.version && v[1] !== pkg.version) {
      add('SW_APP_VERSION', `sw.js の APP_VERSION (${v[1]}) が package.json の version (${pkg.version}) と違う。リリースごとに両方上げる`);
    }
  }

  // ---- E1. manifest の id / scope / start_url ----
  const viteCfg = read(join(root, 'vite.config.js')) || '';
  const manifestJson = read(join(root, 'manifest.webmanifest'));
  const manifestSrc = manifestJson || viteCfg;
  // 正しい値は「どこで配信するか」で変わる。
  // 独自ドメイン（CNAME あり）だとアプリはサブドメインの直下に置かれる。
  //   https://online-100square-calculation.giga-school.com/
  // ここでリポジトリ名の絶対パスのままにすると scope がページの URL を含まなくなり、
  // manifest ごと無視されて PWA としてインストールできなくなる。
  // CNAME が無ければ従来どおり共有オリジンのサブディレクトリ配信なので、
  // リポジトリ名の絶対パスでないと同居する別アプリと取り違えられる。
  const hasCname = !!(read(join(root, 'CNAME')) || read(join(root, 'public', 'CNAME')));
  for (const key of ['id', 'scope', 'start_url']) {
    const m = manifestSrc.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`));
    if (!m) add('MANIFEST_PATH', `manifest に ${key} が無い`);
    else if (hasCname ? !m[1].startsWith('./') : (!m[1].startsWith('/') || m[1] === '/')) {
      add('MANIFEST_PATH', `manifest の ${key} が「${m[1]}」。`
        + (hasCname
          ? 'サブドメイン直下で配信するので相対パス "./" にする'
          : '同一オリジンを共有しているので、リポジトリ名の絶対パスにする'));
    }
  }

  // ---- E3. beforeinstallprompt を <head> の最上部で、外部ファイルで捕まえているか ----
  const indexHtml = read(join(root, 'index.html')) || '';
  if (/beforeinstallprompt/.test(stripComments(indexHtml))) {
    add('INSTALL_HOOK', 'index.html に beforeinstallprompt を直書きしている。CSP の script-src \'self\' で動かなくなる。外部ファイルに切り出す');
  }
  if (!existsSync(join(root, 'public/install-hook.js'))) {
    add('INSTALL_HOOK', 'public/install-hook.js が無い（インストールの合図を取りこぼす）');
  } else {
    // ⚠️ 「<script src> の中で最初か」だけを見ると足りない。
    //    スタイルシートより後ろに置かれても「最初の script」ではあるため通ってしまう。
    //    見るべきは「読み込みを伴うタグの中でいちばん先か」。
    const loaders = [...indexHtml.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']|<link[^>]*rel=["']stylesheet["'][^>]*>/gi)];
    if (!loaders.length || !/install-hook\.js/.test(loaders[0][0])) {
      add('INSTALL_HOOK', 'install-hook.js が、読み込みを伴うタグの中でいちばん先になっていない。通信が遅い端末で合図を取りこぼす');
    }
  }

  // ---- B1. CSP ----
  const csp = indexHtml.match(/<meta[^>]*Content-Security-Policy[^>]*content="([\s\S]*?)"/i);
  if (!csp) add('CSP_MISSING', 'index.html に Content-Security-Policy が無い');
  else {
    const c = csp[1];
    if (/script-src[^;]*'unsafe-inline'/.test(c)) {
      add('CSP_UNSAFE_INLINE', "script-src に 'unsafe-inline' がある。CSP を入れた意味がほとんど無くなる");
    }
    if (/frame-ancestors/.test(c)) {
      add('CSP_FRAME_ANCESTORS', 'frame-ancestors は <meta> では無視され、読み込みのたびに警告が出るだけになる');
    }
  }

  // ---- D7 / E2. 画像 ----
  const iconDirs = [join(root, 'public'), join(root, 'icons')].filter(existsSync);
  for (const dir of iconDirs) {
    for (const name of readdirSync(dir)) {
      if (extname(name) !== '.png') continue;
      const p = join(dir, name);
      const kb = statSync(p).size / 1024;
      const limit = /favicon/.test(name) ? cfg.limits.faviconKB
        : /icon|pwa|apple/.test(name) ? cfg.limits.iconKB
          : cfg.limits.imageKB;
      if (kb > limit) add('IMAGE_SIZE', `${name}: ${kb.toFixed(1)}KB（上限 ${limit}KB）。パレット PNG 化で大きく減らせる`);

      // ⚠️ apple-touch-icon に透明があると、iOS がそこを黒で埋めてホーム画面の四隅が黒くなる
      if (/apple-touch-icon/.test(name) && pngAlphaInfo(p).hasTransparent) {
        add('APPLE_TOUCH_ICON', `${name}: 透明を含んでいる。iOS でアイコンの四隅が黒くなる`);
      }
    }
  }

  // ---- F6. 1ファイルの大きさ ----
  for (const f of srcFiles) {
    const body = read(f) || '';
    const lines = body.split('\n').length;
    const kb = Buffer.byteLength(body) / 1024;
    if (lines > cfg.limits.fileLines || kb > cfg.limits.fileKB) {
      add('FILE_SIZE', `${f.replace(root + '/', '')}: ${lines}行 / ${kb.toFixed(0)}KB（上限 ${cfg.limits.fileLines}行 / ${cfg.limits.fileKB}KB）`, 'warn');
    }
  }

  // ---- §8. 先読みキャッシュの量（ビルド後のみ） ----
  const swDist = read(join(root, 'dist/sw.js'));
  if (swDist) {
    const urls = [...swDist.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]);
    let total = 0;
    for (const u of urls) {
      const p = join(root, 'dist', u);
      if (existsSync(p)) total += statSync(p).size;
    }
    const kb = total / 1024;
    if (kb > cfg.limits.precacheKB) {
      add('PRECACHE_BUDGET', `先読みキャッシュが ${kb.toFixed(0)}KB（上限 ${cfg.limits.precacheKB}KB）。校内 Wi-Fi で40人が同時に開くと初回表示が止まる`);
    }
    if (urls.some((u) => /tfjs/.test(u))) {
      add('PRECACHE_VENDOR', 'TensorFlow.js が先読みキャッシュに入っている。使う端末だけが実行時に取り込む形にする');
    }
  }

  return fail;
}
