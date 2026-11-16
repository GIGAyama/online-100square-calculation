/*
 * 学習ログの集計（src/studyStats.js）のテスト。ブラウザなしで走る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeByMode } from '../src/studyStats.js';

const rec = (over) => ({
  schema: 'study.v1', appId: 'square100', mode: 'mul', status: 'completed', multiplayer: false,
  elapsedMs: 60000, activeMs: 50000,
  summary: { count: 100, attempted: 100, firstTryCorrect: 90, correct: 100 },
  items: [], ext: {},
  ...over,
});

test('「とちゅうでやめた回数」に、制限時間になって終わった回は数えない', () => {
  // 時間切れの回は、完走ではないので学習ログでは 'aborted' になる。
  // しかし自分でやめたのではなく、決めた時間までやりきっている
  const out = summarizeByMode([
    rec({ status: 'aborted', ext: { timeUp: true, timeLimitMs: 120000 }, summary: { count: 100, attempted: 23, firstTryCorrect: 20, correct: 23 } }),
    rec({ status: 'aborted', summary: { count: 100, attempted: 5, firstTryCorrect: 5, correct: 5 } }),   // 「やめる」を押した回
    rec({ status: 'aborted', ext: { autoScore: false }, summary: { count: 100, attempted: 40, firstTryCorrect: 30, correct: 30 } }),   // 空きを残して丸つけ
    rec({}),
  ]);
  assert.equal(out.mul.sessions, 4, '取り組んだ回数には、どれも数える');
  assert.equal(out.mul.aborted, 2, '時間切れの 1 回は「とちゅうでやめた」に入れない');
});

test('時間切れの回も、一発で正解できた率には入る（分母は答えた数）', () => {
  const out = summarizeByMode([
    rec({ status: 'aborted', ext: { timeUp: true }, summary: { count: 100, attempted: 20, firstTryCorrect: 15, correct: 20 } }),
  ]);
  assert.equal(out.mul.recentAttempted, 20);
  assert.equal(out.mul.recentFirstTryCorrect, 15);
  assert.equal(out.mul.firstTryRate, 0.75);
});
