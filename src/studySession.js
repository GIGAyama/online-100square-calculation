/*
 * 100マス計算（appId: square100）の学習ログ組み立て（study.v1 §3.6）
 *
 * 3層構成の中間層。
 *   studyLog.js     … 保存（全アプリ共通・同一ロジック。触らない）
 *   studySession.js … このアプリ固有の組み立て（このファイル）
 *   studyStats.js   … 読み出し・集計
 */
import { saveStudyRecord } from './studyLog';

// 学習ログの appVersion に入れるアプリの版。
// ⚠️ package.json の version と揃えること（`npm run check` の STUDY_APP_VERSION が見る）。
//    src/sw.js の版はキャッシュ名用で、配信物の中身から自動で作られる別物。
//    品質ゲートが見ているのは sw.js と package.json の2つだけなので、
//    ここは上げ忘れても止まらない（README「リリース手順」に手順を書いてある）
export const APP_VERSION = '1.7.1';
export const APP_ID = 'square100';

// 内部で使っている日本語のモード名 → 集計用の英数小文字。
// unit.id を表示文字列から直接生成せず、この対応表から引く（§2.5）。
// 表示名を変えるときは、旧名称も同じ ID に向けるエイリアスをここに残すこと。
export const MODE_ID = {
  'たし算': 'add',
  '引き算': 'sub',
  'かけ算': 'mul',
};

// 設問ID（items.q）に使う演算子。表示用の「×」ではなく安定した ASCII を使う
export const MODE_OP = {
  'たし算': '+',
  '引き算': '-',
  'かけ算': '*',
};

export const answerOf = (mode, rowVal, colVal) => {
  if (mode === 'たし算') return rowVal + colVal;
  if (mode === '引き算') return rowVal - colVal;
  if (mode === 'かけ算') return rowVal * colVal;
  return 0;
};

// 設問ID。式そのものが安定した識別子として機能する形（20文字以内・日本語なし）
// のため、ハッシュ化せずそのまま用いる（§2.10）。
// 行の値は重複しうるので、同じ q が1レコード内に複数現れる点に注意。
export const questionId = (mode, rowVal, colVal) => `${rowVal}${MODE_OP[mode]}${colVal}`;

// ext.input（§3.6）。同じ実力でも入力方法でタイムが大きく変わるため必須扱い
export const inputMethodOf = (settings) => {
  if (settings.handwriting && settings.numpad) return 'mixed';
  if (settings.handwriting) return 'handwriting';
  if (settings.numpad) return 'numpad';
  return 'keyboard';
};

// マスごとの解答状況（回数・初回正答・所要時間・誤答）を貯める入れ物
const getCellStat = (session, key) => {
  let stat = session.stats[key];
  if (!stat) {
    stat = { tries: 0, firstTry: false, ms: 0, wrong: [], lastVal: null };
    session.stats[key] = stat;
  }
  return stat;
};

export const allCellKeys = (rows, cols) => {
  const keys = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) keys.push(`${r}_${c}`);
  }
  return keys;
};

/**
 * セッションを開始する。
 * performance.now() は経過時間の計測にしか使えないため、
 * startedAt は Date から ISO 8601（タイムゾーン付き）で別途生成する（§2.8）。
 *
 * @param cells         マスの総数。unit.id と ext.cells に使う（盤面が同じなら不変）
 * @param scope         このレコードが受け持つマスのキー配列。
 *                      省略時は全マス。中断からの復帰時は残りのマスだけを渡す（§5.4）
 * @param startOffsetSec このセッションが始まった時点の、画面タイマーの経過秒。
 *                      復帰後のレコードが「離れていた時間」を含まないようにする
 */
export function createStudySession({ mode, cells, rows, cols, autoScore, input, scope, startOffsetSec = 0 }) {
  const keys = scope || allCellKeys(rows, cols);
  return {
    startedAt: new Date().toISOString(),
    mode,
    cells,
    count: keys.length,
    scope: new Set(keys),
    startOffsetSec,
    rows,
    cols,
    autoScore,
    input,
    stats: {},
    wrongOnce: new Set(),
    timedKey: null,
    timedSince: 0,
  };
}

/** 解答が確定した（答えの桁数まで入力された）ときに1回だけ呼ぶ */
export function recordAttempt(session, r, c, val, isCorrect) {
  if (!session) return;
  const stat = getCellStat(session, `${r}_${c}`);
  // 同じ値での重複カウントを防ぐ（手書き認識のリトライなど）
  if (stat.lastVal === val) return;
  stat.lastVal = val;
  stat.tries++;
  if (stat.tries === 1 && isCorrect) stat.firstTry = true;
  if (!isCorrect) {
    // 誤答した「問題のID」を Set で持つ。ミス回数の合計から引くと
    // 同じ問題を複数回間違えたときに二重減算される（§2.7）
    session.wrongOnce.add(`${r}_${c}`);
    if (stat.wrong.length < 5) stat.wrong.push(val.slice(0, 12));
  }
}

/** 設問ごとの所要時間。フォーカスの移動を区切りとして加算する */
export function markCellTiming(session, key) {
  if (!session) return;
  const now = performance.now();
  if (session.timedKey !== null) {
    getCellStat(session, session.timedKey).ms += now - session.timedSince;
  }
  session.timedKey = key;
  session.timedSince = now;
}

/**
 * セッションを締めて学習ログに保存する。
 *
 * @param status      'completed' | 'aborted'
 * @param elapsedMs   開始〜終了の実時間。中断時は「タブを離れた時刻」で締めた値（§5.4）
 * @param activeMs    実際に操作していた時間（クランプ前）
 * @param inputs      各マスの最終入力値
 * @param prevBestSec 今回より前のベストタイム（秒）。無ければ undefined
 * @returns 保存したレコードの id。保存しなかった場合は null
 */
export function finalizeStudySession(session, { status, elapsedMs, activeMs, inputs, prevBestSec }) {
  if (!session) return null;

  // 最後に触っていたマスの時間を締める
  if (session.timedKey !== null) {
    getCellStat(session, session.timedKey).ms += performance.now() - session.timedSince;
    session.timedKey = null;
  }

  const items = [];
  let attempted = 0;
  let correct = 0;
  let firstTryCorrect = 0;

  for (let r = 0; r < session.rows.length; r++) {
    for (let c = 0; c < session.cols.length; c++) {
      const key = `${r}_${c}`;
      // 復帰後のレコードは、そのとき残っていたマスだけを受け持つ
      if (!session.scope.has(key)) continue;
      const ans = answerOf(session.mode, session.rows[r], session.cols[c]);
      const finalVal = inputs[key];
      const ok = finalVal !== undefined && finalVal !== '' && parseInt(finalVal, 10) === ans;
      if (ok) correct++;

      const stat = session.stats[key];
      // 一度も手をつけていない問題は attempted / firstTryCorrect / items の
      // いずれからも除外する。未着手を計上すると中断レコードの正答率が
      // 実態と乖離する。未着手数は count - attempted で判る（§2.7）
      if (!stat || stat.tries === 0) continue;
      attempted++;
      if (stat.firstTry) firstTryCorrect++;
      items.push({
        q: questionId(session.mode, session.rows[r], session.cols[c]),
        ok,
        firstTry: stat.firstTry,
        tries: stat.tries,
        ms: Math.round(stat.ms),
        wrong: stat.wrong.length ? stat.wrong : undefined,
      });
    }
  }

  // 1問も解答していない中断は保存しない。
  // 学習データを持たないレコードでログ枠（500件）が埋まる（§5.4）
  if (attempted === 0) return null;

  const roundedElapsedMs = Math.round(elapsedMs);
  // Date.now() と performance.now() の誤差で activeMs > elapsedMs という
  // ありえない値が生じうるため、保存前に必ず抑え込む（§2.8）
  const clampedActiveMs = Math.min(Math.round(activeMs), roundedElapsedMs);

  // ext.bestMs は今回の記録も含めた現時点のベストタイム。
  // 盤面の途中から始まったレコード（復帰後）のタイムはベストにならない
  const wholeBoard = session.count === session.cells;
  const isNewBest = status === 'completed' && wholeBoard && correct === session.count
    && (prevBestSec === undefined || elapsedMs / 1000 < prevBestSec);
  const bestSec = isNewBest ? elapsedMs / 1000 : prevBestSec;

  const modeId = MODE_ID[session.mode];
  return saveStudyRecord({
    appId: APP_ID,
    appVersion: APP_VERSION,
    kind: 'session',
    mode: modeId,
    unit: {
      // マス数は盤面の大きさ。復帰後のレコードでも同じ単元に属するよう count は使わない
      id: `${modeId}-${session.cells}`,
      title: `${session.mode} ${session.cells}マス`,
      preset: true,
    },
    source: 'course',
    multiplayer: false,
    grading: 'objective',
    startedAt: session.startedAt,
    // 中断時に「待っていた5分」を含めないよう、endedAt も締めた時刻から求める
    endedAt: new Date(Date.parse(session.startedAt) + roundedElapsedMs).toISOString(),
    elapsedMs: roundedElapsedMs,
    activeMs: clampedActiveMs,
    timeBasis: 'app',
    status,
    summary: {
      count: session.count,
      attempted,
      firstTryCorrect,
      correct,
    },
    items,
    ext: {
      autoScore: session.autoScore,
      input: session.input,
      cells: session.cells,
      bestMs: bestSec !== undefined ? Math.round(bestSec * 1000) : null,
      // items を持たない簡易集計でも、つまずいた式を辿れるようにする冗長データ
      wrongItems: [...session.wrongOnce]
        .map((key) => {
          const [r, c] = key.split('_').map(Number);
          return questionId(session.mode, session.rows[r], session.cols[c]);
        })
        .slice(0, 100),
    },
  });
}
