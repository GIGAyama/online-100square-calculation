/**
 * このリポジトリだけの検査。
 *
 * 共通の検査は正本（GIGAyama.github.io/standards/lib/giga-v5-checks.mjs）が
 * 受け持つ。ここに残すのは、正本に対応するものが無いものだけである。
 *
 * 移行のとき（2026-08-23）にフォーク32件を正本38件へ1つずつ突き合わせた。
 * 名前が変わっただけのものと、正本では1つにまとまったもの
 * （CSP_MISSING/UNSAFE_INLINE/FRAME_ANCESTORS → B_CSP、
 *  VIEWPORT_FIT/ZOOM → D_VIEWPORT、APPLE_TOUCH_ICON → E_ICONS、
 *  LEGAL_MISSING → A_LICENSE / A_DOCS）を除くと、行き先が無いのは下の
 * 6件（＋作りの前提を見る3件）だった。
 *
 * ⚠️ 検査そのものが壊れていないかは check-project.mjs --self-test が確かめる。
 *    「0件でした」だけでは、効いているのか何も見ていないのか区別できない。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'dev-dist']);

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/**
 * `@media (…条件…) { … }` のブロックを、中括弧を数えて丸ごと取り出す。
 * 正規表現で `}` まで取ると、入れ子の規則で途中打ち切りになる。
 */
function mediaBlocks(src, conditionRe) {
  const re = new RegExp(`@media[^{]*${conditionRe.source}[^{]*\\{`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(src.slice(start, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** セレクタ部分に現れるクラス名を拾う（宣言の中身は見ない） */
const classNamesInSelectors = (css) => {
  const names = new Set();
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

/** 原文を読めば分かるもの。 */
export function runLocalChecks(root, config) {
  const out = [];
  const add = (id, ok, detail, severity = 'P1') => out.push({ id, ok, detail, severity });

  // 正本の E_SW_* はどれも sw.js の中身を読むので、無ければそちらも落ちる。
  // ただし「なぜ落ちたか」が読み取りにくいので、在ることを名指しで見る。
  const swPath = join(root, 'src/sw.js');
  const hasSw = existsSync(swPath);
  add('E_SW_EXISTS', hasSw, hasSw ? 'src/sw.js' : 'src/sw.js が無い');

  // 正本の E_INSTALL_HOOK は「<head> で合図を受けているか」を見る。
  // 読み込んでいる先のファイルが在るかは見ていないので、ここで見る。
  const hookPath = join(root, 'public/install-hook.js');
  const hasHook = existsSync(hookPath);
  add('E3_INSTALL_HOOK_FILE', hasHook, hasHook ? '' : 'public/install-hook.js が無い');

  const srcFiles = walk(join(root, 'src')).filter((f) => /\.(jsx?|css)$/.test(f));
  const allSrc = srcFiles.map((f) => stripComments(read(f) || '')).join('\n');

  // 一斉授業で電子黒板に映す使い方があるアプリ（§2-11）。
  // 提示モードが無いと、教室のうしろの席から読めない。
  if (config.presentationMode !== false) {
    const has = /\.presentation\b/.test(allSrc);
    add('PRESENTATION_MODE', has,
      has ? '' : '提示モード（.presentation）が無い。電子黒板に映したとき、教室のうしろの席から読めない');
  }

  // 紙には横スクロールが無い。
  // ⚠️ ファイルごとに見てはいけない。スクロールさせているのは JSX 側の
  //    Tailwind クラス（overflow-x-auto）で、@media print はスタイルシートにある。
  //    別々のファイルなので、1ファイルずつ見ると永久に一致せず、検査が
  //    「何も見ていないのに通る」状態になる。実際にそうなっていた。
  {
    const printBlocks = mediaBlocks(allSrc, /print/);
    const scrolls = /overflow(-[xy])?\s*:\s*(auto|scroll)/.test(allSrc)
      || /\boverflow(-[xy])?-(auto|scroll)\b/.test(allSrc);
    const bad = printBlocks.length > 0 && scrolls && !printBlocks.some((b) => /overflow/.test(b));
    add('PRINT_SCROLL_CLIP', !bad,
      bad ? 'overflow: auto でスクロールさせているのに、@media print で戻していない。紙には横スクロールが無いので、はみ出した分はそのまま切り取られる' : '');
  }

  // ハイコントラストでは面の色が両方とも消える。片方だけ手当てすると差が消える。
  {
    const received = new Set();
    for (const block of mediaBlocks(allSrc, /forced-colors/)) {
      for (const n of classNamesInSelectors(block)) received.add(n);
    }
    const carriers = colorCarryingClasses(allSrc);
    const missing = [];
    const seen = new Set();
    for (const name of received) {
      const i = name.lastIndexOf('-');
      if (i <= 0) continue;
      const prefix = name.slice(0, i + 1);
      for (const other of carriers) {
        if (other === name || received.has(other) || !other.startsWith(prefix)) continue;
        if (seen.has(other)) continue;
        seen.add(other);
        missing.push(`.${other}（.${name} は受けている）`);
      }
    }
    add('FORCED_COLORS_PAIR', missing.length === 0,
      missing.length === 0 ? '' : `forced-colors で受けられていない対: ${missing.join(' / ')}`);
  }

  // 学習記録に刻む版が package.json と揃っているか。
  // 手で揃える決まりだったが、実際 1.6.0 のまま package.json が 1.7.1 に
  // なっていた（2026-08-22 に発見）。その間の記録はすべて誤った版で残る。
  {
    const study = read(join(root, 'src/studySession.js'));
    const pkg = JSON.parse(read(join(root, 'package.json')) || '{}');
    if (study) {
      const sv = study.match(/APP_VERSION\s*=\s*['"]v?([^'"]+)['"]/);
      if (!sv) add('STUDY_APP_VERSION', false, 'src/studySession.js に APP_VERSION が無い');
      else {
        const same = !pkg.version || sv[1] === pkg.version;
        add('STUDY_APP_VERSION', same,
          same ? `${sv[1]}` : `src/studySession.js の APP_VERSION (${sv[1]}) が package.json の version (${pkg.version}) と違う。学習記録の appVersion に誤った版が残ります`);
      }
    }
  }

  return out;
}

/**
 * ビルドした結果を見るもの。
 *
 * このアプリは vite-plugin-pwa の injectManifest を使う。先読み一覧は
 * ビルド時に dist/sw.js へ注入されるので、原文をいくら読んでも中身が
 * 決まらない（正本の E_SW_PRECACHE_OFFLINE は、そのことを宣言してあるかだけを
 * 見て、実際の中身はここに任せている）。
 *
 * dist が無ければ「まだビルドしていない」として落とす。黙って素通りさせると、
 * ビルド結果を見る検査が丸ごと効かないまま緑になる。
 */
export function runBuildChecks(root, config) {
  const out = [];
  const add = (id, ok, detail, severity = 'P1') => out.push({ id, ok, detail, severity });
  const dist = join(root, 'dist');
  if (!existsSync(dist)) {
    add('BUILD_PRESENT', false, 'dist/ がありません。先に npm run build を実行してください');
    return out;
  }
  add('BUILD_PRESENT', true, 'dist/ があります');

  const swDist = read(join(dist, 'sw.js'));
  if (!swDist) {
    add('E10_OFFLINE_PRECACHED', false, 'dist/sw.js がありません');
    return out;
  }

  // 圏外で出す1枚が、実際に先読みへ入ったか。
  const hasOffline = /offline\.html/.test(swDist);
  add('E10_OFFLINE_PRECACHED', hasOffline,
    hasOffline ? '注入された先読みに入っています' : '注入された先読みに offline.html がありません（圏外では出せません）');

  // §8 総アセット（初回）。校内 Wi-Fi で40人が同時に開く前提。
  const urls = [...swDist.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]);
  let total = 0;
  for (const u of urls) {
    const p = join(dist, u);
    if (existsSync(p)) total += statSync(p).size;
  }
  const kb = total / 1024;
  const within = kb <= config.limits.precacheKB;
  add('PRECACHE_BUDGET', within,
    `${kb.toFixed(0)}KB (上限 ${config.limits.precacheKB}KB)`
    + (within ? '' : '。校内 Wi-Fi で40人が同時に開くと初回表示が止まる'));

  const vendor = urls.some((u) => /tfjs/.test(u));
  add('PRECACHE_VENDOR', !vendor,
    vendor ? 'TensorFlow.js が先読みキャッシュに入っている。使う端末だけが実行時に取り込む形にする' : '');

  return out;
}
