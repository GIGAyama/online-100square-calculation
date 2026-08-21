/* =====================================================================
 * records-hub-client.js — 学習アプリに置く「記録ハブへの写し」
 * =====================================================================
 * これは **学習アプリ側のリポジトリ** に入れるファイルです。
 * まなびクエスト／学習ポータルのリポジトリでは使いません。
 *
 * 入れかた（アプリのHTMLの終わりのほうに1行）
 * ---------------------------------------------------------------------
 *   <script src="./records-hub-client.js" defer></script>
 *
 * このファイルをアプリのリポジトリにコピーしてください。
 * gamification.giga-school.com から直接読み込むこともできますが、
 * 校内のフィルタでそのアドレスが止められるとアプリの読み込みが遅れるため、
 * **コピーして自分のところに置く**のをおすすめします。
 *
 * 何をするか
 * ---------------------------------------------------------------------
 * アプリが localStorage（study.records.v1）に書いた学習ログを、
 * 見えない iframe 経由で「記録ボックス」へ写します。写すだけで、
 * アプリ側の記録には一切さわりません（消しも書きかえもしません）。
 *
 * アプリのコードを変えなくても、読み込むだけで動きます。
 *   ・ページを開いたとき
 *   ・60秒ごと（画面が見えている間）
 *   ・別の画面に切りかえたとき／ページを閉じるとき
 * に、まだ写していない記録を送ります。
 *
 * 記録を書いた直後にすぐ写したいときは、アプリ側から次を呼んでください。
 *   window.GigaRecordsHub && window.GigaRecordsHub.sync();
 *
 * なぜ要るのか
 * ---------------------------------------------------------------------
 * 学習ログはオリジン（＝サブドメイン）ごとに分かれて保存されるため、
 * 学習ポータルからは自分のオリジンのぶんしか見えません。
 * 全アプリぶんを1か所に集めておくことで、ポータルは往復なしに集計でき、
 * 送信ずみの記録をきちんと片づけられるようになります。
 *
 * 安全のために
 * ---------------------------------------------------------------------
 * ・送り先は https://gamification.giga-school.com に固定しています（'*' は使いません）
 * ・受け取る返事も、そのオリジンからのものだけを見ます
 * ・写しに失敗しても、アプリの動作には影響しません（記録は手元に残ります）
 * ・同一サイト（giga-school.com）でないところから読み込まれたときは、
 *   ブラウザのストレージ分割で写しが届かないため、何もしません
 * ===================================================================== */
(() => {
  'use strict';

  const HUB_ORIGIN = 'https://gamification.giga-school.com';
  const HUB_URL = HUB_ORIGIN + '/records-hub.html';

  const LOG_KEY = 'study.records.v1';        // アプリが書く学習ログ（原本。ここは読むだけ）
  const MARK_KEY = 'study.hub.mirrored.v1';  // どこまで写したか（このアプリのオリジンに置く控え）

  const BATCH_SIZE = 100;                    // 1通で送る件数（ハブの上限は200）
  const REPLY_TIMEOUT_MS = 10000;            // 返事を待つ上限
  const FRAME_TIMEOUT_MS = 15000;            // iframe が開くのを待つ上限
  const INTERVAL_MS = 60000;                 // 画面が見えている間、この間隔で写す
  const MARK_IDS_MAX = 200;                  // 念のため控えておく「最後に写した id」の数

  /** 同一サイトか。別サイトからではストレージ分割により写しが届きません */
  function isSameSite() {
    if (location.origin === HUB_ORIGIN) return true;
    return /(^|\.)giga-school\.com$/i.test(location.hostname);
  }

  if (!isSameSite()) return;   // 何もしない（アプリの動作には影響しません）

  let frame = null;
  let framePromise = null;
  let running = false;
  let timer = null;
  let seq = 0;
  const waiting = new Map();

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const value = JSON.parse(raw);
      return (value === null || value === undefined) ? fallback : value;
    } catch (e) { return fallback; }
  }

  function readLog() {
    const list = readJson(LOG_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  /** どこまで写したか。count は「原本の何件目まで写したか」、ids は取りこぼし防止の控え */
  function readMark() {
    const mark = readJson(MARK_KEY, {});
    const count = (mark && typeof mark.count === 'number' && mark.count >= 0) ? Math.floor(mark.count) : 0;
    const ids = (mark && Array.isArray(mark.ids)) ? mark.ids.filter(id => typeof id === 'string') : [];
    return { count, ids };
  }

  function writeMark(count, log) {
    const ids = log.slice(Math.max(0, log.length - MARK_IDS_MAX))
      .map(rec => (rec && typeof rec.id === 'string') ? rec.id : null)
      .filter(Boolean);
    try { localStorage.setItem(MARK_KEY, JSON.stringify({ count, ids })); }
    catch (e) { /* 控えを書けなくても、次はもう一度写すだけです（ハブが重複を弾きます） */ }
  }

  function isRecord(rec) {
    return !!rec && typeof rec === 'object' && !Array.isArray(rec)
      && rec.schema === 'study.v1' && typeof rec.id === 'string' && rec.id.length >= 8;
  }

  /** 見えない iframe でハブを開きます。1枚だけ作って、そのまま使い続けます */
  function openHub() {
    if (framePromise) return framePromise;
    framePromise = new Promise(resolve => {
      const el = document.createElement('iframe');
      el.title = '記録ハブ';
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('tabindex', '-1');
      // 画面には出しませんが display:none にはしません。
      // 読み込まない実装のブラウザだと load が来ず、必ず時間切れになるためです。
      el.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0;';
      // ⚠️ sandbox は付けません。付けるとこの iframe の origin が "null" になり、
      //    ハブが「同一サイトからの写し」と判断できなくなって受け取ってもらえません。
      el.src = HUB_URL;

      let settled = false;
      const done = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        frame = ok ? el : null;
        if (!ok && el.parentNode) el.parentNode.removeChild(el);
        // 開けなかったときは、次の機会にもう一度ためせるようにします
        if (!ok) framePromise = null;
        resolve(frame);
      };
      const guard = setTimeout(() => done(false), FRAME_TIMEOUT_MS);
      el.addEventListener('load', () => done(true));
      el.addEventListener('error', () => done(false));
      document.body.appendChild(el);
    });
    return framePromise;
  }

  function push(records) {
    return new Promise(resolve => {
      if (!frame || !frame.contentWindow) { resolve(null); return; }
      const reqId = 'm' + (++seq);
      const timeout = setTimeout(() => { waiting.delete(reqId); resolve(null); }, REPLY_TIMEOUT_MS);
      waiting.set(reqId, { resolve, timeout });
      try {
        frame.contentWindow.postMessage({
          type: 'giga.hub.push',
          v: 1,
          reqId,
          appId: (records[0] && records[0].appId) || '',
          records
        }, HUB_ORIGIN);
      } catch (e) {
        clearTimeout(timeout);
        waiting.delete(reqId);
        resolve(null);
      }
    });
  }

  window.addEventListener('message', event => {
    if (event.origin !== HUB_ORIGIN) return;
    if (!frame || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type !== 'giga.hub.result' && message.type !== 'giga.hub.pong') return;
    const pending = waiting.get(message.reqId);
    if (!pending) return;
    waiting.delete(message.reqId);
    clearTimeout(pending.timeout);
    pending.resolve(message);
  });

  /**
   * まだ写していない記録をハブへ送ります。
   *
   * 原本は追記されていくので、ふだんは「前回までの件数から先」だけを送れば足ります。
   * アプリが記録を並べかえたり消したりして件数が合わなくなったときは、
   * 安全側に倒して全部を送り直します（同じ id はハブが弾くので二重にはなりません）。
   */
  async function sync() {
    if (running) return;
    running = true;
    try {
      const log = readLog();
      if (log.length === 0) return;

      const mark = readMark();
      const fresh = (mark.count <= log.length) ? log.slice(mark.count) : log.slice();
      const knownIds = new Set(mark.ids);
      const pending = fresh.filter(rec => isRecord(rec) && !knownIds.has(rec.id));
      if (pending.length === 0) {
        if (mark.count !== log.length) writeMark(log.length, log);
        return;
      }

      if (!await openHub()) return;   // 開けなかった。次の機会にやり直します

      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const result = await push(pending.slice(i, i + BATCH_SIZE));
        // 返事が無い・断られた（保存領域が尽きたなど）ときは控えを進めません。
        // 記録は原本に残っているので、次の機会に送り直せます。
        if (!result || !result.ok) return;
      }
      writeMark(log.length, log);
    } catch (e) {
      // 写しの失敗でアプリを止めません
    } finally {
      running = false;
    }
  }

  function start() {
    sync();
    if (timer === null) {
      timer = setInterval(() => { if (!document.hidden) sync(); }, INTERVAL_MS);
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) sync(); });
    // Chromebook でタブが捨てられるときにも、できるだけ写してから終わります。
    // unload は出ないことがあるので pagehide を使います。
    window.addEventListener('pagehide', () => { sync(); });
  }

  // アプリから「いま写して」と言えるようにしておきます（記録を書いた直後など）
  window.GigaRecordsHub = { sync };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
