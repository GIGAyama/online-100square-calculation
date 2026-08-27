// ==========================================================
// 学習ログの受け渡し口(読み取り専用)
// ==========================================================
/*
 * 独自ドメインへ移る前、アプリはすべて gigayama.github.io という
 * ひとつのオリジンに置かれていた。localStorage はオリジンごとに分かれるので、
 * 同じ 'study.records.v1' を全アプリで読み書きでき、集計ページはそれを
 * そのまま読むだけで横断集計ができていた。
 *
 * サブドメインに分かれると、このアプリとほかのアプリは
 * 別のオリジンになり、この共有は成り立たない。
 *
 * そこで、集計ページ(manabi-portal)から同一サイトの iframe で開かれたときだけ、
 * このオリジンの学習ログを postMessage で渡す。
 *
 * ・サブドメイン同士は「同一サイト」(eTLD+1 が giga-school.com)なので、
 *   ブラウザの third-party ストレージ分割の対象にならず、
 *   iframe の中でも第一者と同じ localStorage が見える。
 * ・このファイルは読むだけ。書き込みも削除も一切しない。
 *   集計側の不具合でアプリのデータが壊れることが原理的に起きないようにしてある。
 * ・渡す相手は giga-school.com とそのサブドメインだけに限る。
 */
const STUDY_LOG_KEY = 'study.records.v1';
const APP_ID = '__APP_ID__';

// 受け渡しを許す相手。
// ・^ と $ で全体を縛る。前方一致にすると giga-school.com.example.com が通る
// ・サブドメイン部分は任意。giga-school.com 自身(集計ページの置き場)も許す
const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?giga-school\.com$/;

// 手元で確かめるとき用。http://localhost:1234 など
const isLocal = (o) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

export function isAllowedOrigin(origin) {
  return typeof origin === 'string' && (ALLOWED_ORIGIN.test(origin) || isLocal(origin));
}

// 壊れた JSON でも集計側を落とさない。読めなければ「記録なし」として扱う。
export function parseRecords(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function readRecords() {
  let raw = null;
  try { raw = localStorage.getItem(STUDY_LOG_KEY); } catch { return []; }
  return parseRecords(raw);
}

// Node から検査・テストで読み込めるように、画面がないところでは何も繋がない。
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (!isAllowedOrigin(e.origin)) return;
    const msg = e.data;
    if (!msg || msg.type !== 'giga.records.request') return;

    // 送り返す先は「聞いてきた相手」に限る。'*' にしない。
    e.source.postMessage({
      type: 'giga.records.response',
      nonce: msg.nonce,      // どの問い合わせへの返事かを集計側が見分けるため
      appId: APP_ID,
      schema: 'study.v1',
      records: readRecords(),
    }, e.origin);
  });

  // ここから親へ声をかけることはしない。
  // 「読み込みが終わった」と知らせるだけでも、宛先を '*' にすると
  // 埋め込んだ相手が誰であっても届いてしまう。中身が無害かどうかとは別に、
  // 宛先を絞れない postMessage を1本でも残すと、あとから中身が足されたときに
  // 気づけない。集計側は iframe の load を合図にすればよい
  // （このファイルは module なので、load の時点で受け口はできている）。
}
