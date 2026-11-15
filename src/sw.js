/*
 * 100マス計算 — Service Worker（GIGA Standard v5 §3-3）
 *
 * 【重要】activate では自アプリ以外のキャッシュを削除しない。
 *   旧配信元の gigayama.github.io は数十個のアプリが同一オリジンを共有していた。
 *   同居する配置に戻したときに他アプリを巻き込まないよう、
 *   CACHE_PREFIX で始まるキャッシュだけを掃除する。
 *   （caches.keys() を全消しすると、他のアプリがオフラインで起動しなくなる）
 *
 * Service Worker は localStorage を一切操作しない。
 * 学習ログ `study.records.v1` は複数アプリ共通のため、ここから触れてはならない。
 */
const CACHE_PREFIX = 'square100-';
// ⚠️ この行は手で直さない。`npm run build` のあと tools/build-sw.mjs が
//    dist/sw.js の版を「配信物の中身のハッシュ」に書き換える。
//    手書きだったころは package.json の version と揃えるのが決まりだったが、
//    2026-08-21 に12リポジトリで同時に上げ忘れる事故が起きた。上げ忘れると
//    古いシェルのキャッシュが掃除されず、直した画面が児童の端末に一度も
//    届かないまま「直したはずなのに直らない」が続く。
const APP_VERSION = '__APP_VERSION__';
const CACHE_STATIC = CACHE_PREFIX + 'static-' + APP_VERSION;
const CACHE_RUNTIME = CACHE_PREFIX + 'runtime-' + APP_VERSION;

// ビルド時に vite-plugin-pwa が差し込む先読み一覧。
// 手書き用の TensorFlow.js（約1MB）は globIgnores で外してある。
// 先読みが1MBを超えると、校内 Wi-Fi で40人が同時に開いたときに
// 初回表示が止まるため（§6・§8）。TensorFlow.js は下の CacheFirst で
// 「実際に手書きを使った端末だけ」がキャッシュする。
//
// ⚠️ 重複を必ず落とす。差し込まれる一覧には同じファイルが 2 回入ることがある
//    （アイコンは manifest の分と glob の分、offline.html などは includeAssets の分と
//    glob の分）。実測（2026-11-15）で 30 件中 10 件が重複しており、
//    入れるたびに 120KB を 2 回ダウンロードしていた。
const PRECACHE_URLS = [...new Set((self.__WB_MANIFEST || []).map((entry) =>
  typeof entry === 'string' ? entry : entry.url
))];

// 画面遷移の返事を待つ上限。これを過ぎても返事が無く、手元に控えがあれば控えを先に出す。
// ⚠️ 0 にしない（＝いつも控えから出す形にしない）。直した画面が届くのが 1 回おくれる。
const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const cache = await caches.open(CACHE_STATIC);
  // 1本でも失敗すると addAll 全体が落ちるため、個別に入れる
  await Promise.all(PRECACHE_URLS.map((u) =>
    cache.add(new Request(u, { cache: 'reload' }))
      .catch((err) => console.warn('[sw] precache skipped', u, err))));
  // ここでは skipWaiting しない。
  // 児童が計算している最中に画面が入れ替わると、打ちかけの答えも
  // 計っているタイムも消える。画面側で「さいしんに する」を
  // 押してもらってから切り替える。
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys
    .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_STATIC && k !== CACHE_RUNTIME)
    .map((k) => caches.delete(k)));            // ← 自アプリ分だけ削除
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;   // 外部（Google Fonts 等）は素通し

  // 画面遷移は network-first。更新をすぐ届け、圏外なら手元の控えを出す
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      // 手元の控え。まず「開こうとした画面そのもの」を探す。これを飛ばして
      // index.html から返すと、圏外では利用規約を開いてもアプリが出る。
      const fromCache = async () =>
        (await caches.match(req)) || (await caches.match('./index.html'));

      // ⚠️ 「つながっているのに返事が来ない」回線（混んだ校内 Wi-Fi・認証待ちのプロキシ）では
      //    fetch がいつまでも終わらない。圏外ならすぐ失敗して控えが出るのに、
      //    こちらは控えがあっても画面が出ない。
      //    実測（2026-11-15）: 返事が 8 秒おくれる回線で 8.1 秒、返事が来ない回線では
      //    40 秒待ってもマスが出なかった（圏外なら 0.1 秒）。
      //    NAV_TIMEOUT_MS だけ待ち、それでも来なければ控えを出す。
      const network = fetch(req);
      network.catch(() => { });   // 控えを出したあとで失敗しても、未処理の失敗として残さない
      let timer;
      const slow = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS);
      });
      try {
        const res = await Promise.race([network, slow]);
        if (res) return res;
        // 時間切れ。控えがあればそれを出し、無ければ待つしかない
        return (await fromCache()) || (await network);
      } catch {
        // 圏外
        return (await fromCache())
          || (await caches.match('./offline.html'))
          || Response.error();
      } finally {
        clearTimeout(timer);
      }
    })());
    return;
  }

  // 静的ファイルは cache-first（校内Wi-Fiが混んでいても即表示）。
  // TensorFlow.js は先読みしていないので、初めて手書きを使ったときに
  // ここで取り込まれ、以降はオフラインでも手書きが使える
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // 不完全な応答（opaque・エラー）をキャッシュに残すと、
      // 次回以降ずっと壊れたものを返し続けることになる
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_RUNTIME).then((c) => c.put(req, copy));
      }
      return res;
    } catch (err) {
      return (await caches.match('./offline.html')) || Response.error();
    }
  })());
});

self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data) return;
  if (data.type === 'SKIP_WAITING') self.skipWaiting();

  // はじめて開いたとき、画面はまだ Service Worker の管理下にない。
  // その間に画面が取りにいったもの（手書きの TensorFlow.js・書体）は上の fetch を
  // 通らないので、キャッシュに残らない。
  // 実測（2026-11-15）: オンラインで 1 回開いただけの端末にはキャッシュに TensorFlow.js が無く、
  // 2 回開いてはじめて入っていた。「一度使えば圏外でも手書きが使える」が成り立っていなかった。
  // 画面から「もう取ったもの」の一覧（src/pwa.js の keepLoadedFilesOffline）をもらい、
  // 足りない分だけ控える。直前に取ったばかりなので、ふつうは HTTP キャッシュから返る。
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE_RUNTIME);
      for (const raw of data.urls.slice(0, 40)) {
        try {
          const url = new URL(raw, self.location.href);
          if (url.origin !== self.location.origin) continue;   // 自分のところのものだけ
          if (await caches.match(url.href)) continue;          // もう持っている
          const res = await fetch(url.href);
          if (res.ok && res.type === 'basic') await cache.put(url.href, res);
        } catch {
          // 取れなくてもよい。次に開いたときに fetch の側が控える
        }
      }
    })());
  }
});
