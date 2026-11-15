// Service Worker の登録と、更新の案内（GIGA Standard v5 §3-3 / §3-6）
//
// このファイルは React の外側に置いてある。
// ⚠️ 登録処理を React の useEffect に移すと、effect は描画のあとに走るため
//    そのとき load はすでに終わっており、リスナーが二度と呼ばれず
//    Service Worker が黙って登録されなくなる（§3-6）。

/**
 * @param {(onAccept: () => void) => void} onUpdateReady
 *   新しい版が待機していることを画面に伝えるための呼び出し。
 *   受け取った onAccept を、利用者がボタンを押したときに呼ぶ。
 */
export function registerServiceWorker(onUpdateReady) {
  if (!('serviceWorker' in navigator)) return;

  // ⚠️ controllerchange は、はじめて開いたときにも飛んでくる。
  //    activate の clients.claim() でページが管理下に入るためである。
  //    これを素直に受けると「初回訪問が必ず1回リロードされる」ことになり、
  //    100マス計算では打ちかけの答えと計測中のタイムが消える。
  //
  //    「もともと管理下だったか」で分ける直し方は別の形で壊れる。
  //    入れた直後に更新を押した場合、切り替わったのに読み込み直されなくなる。
  //    見るべきは「利用者が押したかどうか」だけ。
  let userAskedUpdate = false;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!userAskedUpdate || reloading) return;
    reloading = true;
    location.reload();
  });

  const notify = (worker) => {
    if (!worker) return;
    onUpdateReady(() => {
      userAskedUpdate = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  const start = async () => {
    try {
      const registration = await navigator.serviceWorker.register(
        `${import.meta.env.BASE_URL}sw.js`,
        { scope: import.meta.env.BASE_URL }
      );

      registration.addEventListener('updatefound', () => {
        const sw = registration.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // controller が居る＝初回インストールではなく更新。
          // 初回で通知すると「入れた直後に更新があります」と出て混乱する
          if (sw.state === 'installed' && navigator.serviceWorker.controller) notify(sw);
        });
      });

      // 前回のうちに入っていた場合も拾う
      if (registration.waiting && navigator.serviceWorker.controller) notify(registration.waiting);

      // はじめて開いたときに画面が先に取ってしまった分を、控えてもらう
      keepLoadedFilesOffline();
    } catch (e) {
      // 登録できなくてもアプリ自体は動く。オフラインで開けないだけ
      console.warn('[pwa] Service Worker の登録に失敗しました', e);
    }
  };

  // ✅ もう load が済んでいるなら、その場で走らせる（§3-6）
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/**
 * 画面がもう取りにいったファイルを、Service Worker に控えてもらう。
 *
 * はじめて開いたとき、画面はまだ Service Worker の管理下にない。その間に取ったもの
 * （手書きの TensorFlow.js・書体）は sw.js の fetch を通らず、キャッシュに残らない。
 * 実測（2026-11-15）: オンラインで 1 回開いただけの端末には TensorFlow.js が残らず、
 * 圏外では手書きが「AIの準備に失敗しました」になっていた。
 *
 * 呼ぶのは 2 か所。Service Worker の登録が済んだとき（上の start）と、
 * 手書きの読み取りモデルを読み終えたとき（App.jsx）。TensorFlow.js は登録より
 * あとに読み終わることがあるため、片方だけでは取りこぼす。
 *
 * ⚠️ 送るのは /assets/ の下（ビルドが名前に中身のハッシュを付けたもの）だけ。
 *    名前が変わらないファイルをここで控えると、直しても古いものが出つづける。
 */
export function keepLoadedFilesOffline() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready.then((registration) => {
    const worker = registration.active;
    if (!worker) return;
    const urls = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          const url = new URL(name);
          return url.origin === location.origin && url.pathname.includes('/assets/');
        } catch {
          return false;
        }
      });
    if (urls.length) worker.postMessage({ type: 'CACHE_URLS', urls: [...new Set(urls)] });
  }).catch(() => {
    // 控えられなくてもアプリは動く。次に開いたときに sw.js の fetch が控える
  });
}

/** ホーム画面／デスクトップにインストール済みで開いているか */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}
