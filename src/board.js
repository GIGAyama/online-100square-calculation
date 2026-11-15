/*
 * 盤面（上と左に並べる数）を作る。
 *
 * 画面に依存しない処理だけを置く。tests/board.test.mjs が Node から直接読んで
 * 確かめるので、ここでは React もブラウザの機能も使わないこと。
 */

/** 偏りのないシャッフル (Fisher–Yates)。もとの配列は変えない */
export const shuffle = (array, random = Math.random) => {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const range = (from, length) => Array.from({ length }, (_, i) => from + i);

/** 左に並べられる数の全部。引き算は 10〜19、たし算・かけ算は 0〜9 */
export const rowPool = (mode) => (mode === '引き算' ? range(10, 10) : range(0, 10));

/** 上に並べる数。いつも 0〜9 を並べかえた 10 個 */
export const makeCols = (random = Math.random) => shuffle(range(0, 10), random);

/**
 * 左に並べる数を選ぶ。
 *
 * ⚠️ 1 行ずつ乱数で選ばないこと。以前はそうしていたので、同じ数の行が重なっていた。
 *    20 万回ためした結果（2026-11-15）:
 *      ・100 問の盤面に出る式は、100 通りのうち平均 65 通り
 *      ・0〜9 が全部そろう盤面は 0.04%
 *      ・35% の盤面で、特定の数（たとえば 7 のだん）が 1 行も出ない
 *    100 問をやっても 100 通りの計算を練習したことにならず、同じ行が 2 つあると
 *    上の行の答えを見て写せてしまう。
 *    並べかえてから先頭を取る形にして、同じ数は 1 回だけ出す。
 *    100 問（10 行）なら、0〜9（引き算は 10〜19）が 1 回ずつ出る。
 *
 * @param mode      'たし算' | '引き算' | 'かけ算'
 * @param rowsCount 行数（問題数 ÷ 10）
 * @param only      出してよい数（かけ算で「だん」を選んだとき）。空なら全部から選ぶ
 */
export function pickRows(mode, rowsCount, only = [], random = Math.random) {
  return shuffle(allowedRows(mode, only), random).slice(0, rowsCount);
}

/**
 * 左に出してよい数。only に入っている数だけに絞る。
 * 何も選んでいない（または、その計算に無い数だけを選んでいる）ときは全部。
 */
export function allowedRows(mode, only = []) {
  const pool = rowPool(mode);
  const picked = pool.filter((n) => only.includes(n));
  return picked.length ? picked : pool;
}

/**
 * その選び方で出せる問題数の上限。
 * 同じ数は 1 行だけなので、行数は「出してよい数」の個数まで
 * （7 のだんだけなら 10 問、3 つ選べば 30 問まで）。
 */
export const maxCount = (mode, only = []) => allowedRows(mode, only).length * 10;
