/*
 * タイムの表し方（分と秒に分ける・「分」の読み）。
 *
 * 画面に依存しない処理だけを置く。tests/timeText.test.mjs が Node から直接読んで
 * 確かめるので、ここでは React もブラウザの機能も使わないこと。
 */

/**
 * 秒を「分」と「秒」に分ける。秒は 0.1 秒きざみ。
 *
 * ⚠️ 先に 0.1 秒きざみに丸めてから分けること。分けてから丸めると、
 *    59.96 秒が「0分60.0秒」に、119.97 秒が「1分60.0秒」になる。
 *
 * @returns {{ minutes: number, seconds: number }} seconds は 0〜59.9
 */
export function splitTime(sec) {
  const tenths = Math.max(0, Math.round((Number(sec) || 0) * 10));
  const minutes = Math.floor(tenths / 600);
  return { minutes, seconds: (tenths - minutes * 600) / 10 };
}

/**
 * のこり時間を「分」と「秒」に分ける。秒は切り上げた整数。
 * 切り上げるのは、0.4 秒のこっているのに「0秒」と出さないため
 * （「0秒」と出るのは、本当に時間になったときだけ）。
 */
export function splitRemaining(sec) {
  const whole = Math.max(0, Math.ceil((Number(sec) || 0) - 1e-9));
  return { minutes: Math.floor(whole / 60), seconds: whole % 60 };
}

/**
 * 「分」の読み。数によって「ふん」と「ぷん」に分かれる。
 *   ぷん … 1分（いっぷん）・3分・4分・6分・8分・10分
 *   ふん … 2分・5分・7分・9分
 * 2 けたのときも、下 1 けたで決まる（11分 = じゅういっぷん、12分 = じゅうにふん、20分 = にじゅっぷん）。
 * ふりがなを付ける相手は低学年なので、読みをまちがえたまま出さない。
 */
export function minuteReading(minutes) {
  return [1, 3, 4, 6, 8, 0].includes(Math.abs(Math.trunc(minutes)) % 10) ? 'ぷん' : 'ふん';
}

/**
 * 文字だけでタイムを書く（ふりがなを付けられない所で使う。読み上げ用の名前など）。
 * 例: 45.3 → 「45.3秒」、125.3 → 「2分5.3秒」
 */
export function timeLabel(sec) {
  const { minutes, seconds } = splitTime(sec);
  return minutes > 0 ? `${minutes}分${seconds.toFixed(1)}秒` : `${seconds.toFixed(1)}秒`;
}

/** 制限時間の書き方。例: 60 → 「1分」、90 → 「1分30秒」、45 → 「45秒」 */
export function limitLabel(sec) {
  const { minutes, seconds } = splitRemaining(sec);
  if (minutes > 0 && seconds > 0) return `${minutes}分${seconds}秒`;
  return minutes > 0 ? `${minutes}分` : `${seconds}秒`;
}
