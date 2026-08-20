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
// ⚠️ リリースごとに必ず上げる。package.json の version と一致させること
//    （`npm run check` の APP_VERSION 検査が食い違いを見つける）
const APP_VERSION = 'v1.7.0';
const CACHE_STATIC = CACHE_PREFIX + 'static-' + APP_VERSION;
const CACHE_RUNTIME = CACHE_PREFIX + 'runtime-' + APP_VERSION;

// ビルド時に vite-plugin-pwa が差し込む先読み一覧。
// 手書き用の TensorFlow.js（約1MB）は globIgnores で外してある。
// 先読みが1MBを超えると、校内 Wi-Fi で40人が同時に開いたときに
// 初回表示が止まるため（§6・§8）。TensorFlow.js は下の CacheFirst で
// 「実際に手書きを使った端末だけ」がキャッシュする。
const PRECACHE_URLS = (self.__WB_MANIFEST || []).map((entry) =>
  typeof entry === 'string' ? entry : entry.url
);

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
      try {
        return await fetch(req);
      } catch {
        // 圏外。まず「開こうとした画面そのもの」を探す。これを飛ばして
        // index.html から返すと、圏外では利用規約を開いてもアプリが出る。
        return (await caches.match(req))
          || (await caches.match('./index.html'))
          || (await caches.match('./offline.html'))
          || Response.error();
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
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
