/*
 * インストールの合図（beforeinstallprompt）を、いちばん先に受け取るための小さな処理。
 *
 * Chrome は条件が揃うと即座に beforeinstallprompt を出すため、
 * React の読み込みより後に構えていると合図を取りこぼし、
 * 通信が遅い端末で「インストール」ボタンが出なくなる。
 *
 * CSP に 'unsafe-inline' を足さずに済むよう、index.html への直書きではなく
 * この外部ファイルにして <head> の先頭で同期読み込みする（§2-13・§3-2）。
 */
(function () {
  window.__pwaInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__pwaInstallPrompt = e;
    window.dispatchEvent(new Event('pwa-install-available'));
  });
  window.addEventListener('appinstalled', function () {
    window.__pwaInstallPrompt = null;
    window.dispatchEvent(new Event('pwa-installed'));
  });
})();
