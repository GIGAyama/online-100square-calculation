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
    } catch (e) {
      // 登録できなくてもアプリ自体は動く。オフラインで開けないだけ
      console.warn('[pwa] Service Worker の登録に失敗しました', e);
    }
  };

  // ✅ もう load が済んでいるなら、その場で走らせる（§3-6）
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/** ホーム画面／デスクトップにインストール済みで開いているか */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}
