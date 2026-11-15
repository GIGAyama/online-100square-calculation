/*
 * タイムの表し方（src/timeText.js）のテスト。ブラウザなしで走る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTime, splitRemaining, minuteReading, timeLabel, limitLabel } from '../src/timeText.js';

test('60 秒より短いタイムは、秒だけで出す', () => {
  assert.deepEqual(splitTime(0), { minutes: 0, seconds: 0 });
  assert.deepEqual(splitTime(45.3), { minutes: 0, seconds: 45.3 });
  assert.deepEqual(splitTime(59.94), { minutes: 0, seconds: 59.9 });
  assert.equal(timeLabel(45.3), '45.3秒');
});

test('60 秒以上のタイムは、分と秒に分ける', () => {
  assert.deepEqual(splitTime(60), { minutes: 1, seconds: 0 });
  assert.deepEqual(splitTime(125.3), { minutes: 2, seconds: 5.3 });
  assert.deepEqual(splitTime(612.4), { minutes: 10, seconds: 12.4 });
  assert.equal(timeLabel(125.3), '2分5.3秒');
  assert.equal(timeLabel(612.4), '10分12.4秒');
});

test('丸めたせいで「60.0秒」が出ることはない', () => {
  // 分けてから丸めると 59.96 秒が「0分60.0秒」、119.97 秒が「1分60.0秒」になる
  assert.deepEqual(splitTime(59.96), { minutes: 1, seconds: 0 });
  assert.deepEqual(splitTime(119.97), { minutes: 2, seconds: 0 });
  for (let tenths = 0; tenths < 20000; tenths++) {
    const { seconds } = splitTime(tenths / 10 + 0.04);
    assert.ok(seconds < 60, `${tenths / 10} 秒`);
  }
});

test('おかしな値でも落ちない', () => {
  assert.deepEqual(splitTime(undefined), { minutes: 0, seconds: 0 });
  assert.deepEqual(splitTime(-3), { minutes: 0, seconds: 0 });
  assert.deepEqual(splitTime(NaN), { minutes: 0, seconds: 0 });
});

test('「分」の読みは、数によって「ふん」と「ぷん」に分かれる', () => {
  const pun = [1, 3, 4, 6, 8, 10, 11, 13, 20, 30];
  const fun = [2, 5, 7, 9, 12, 15, 17, 19];
  for (const n of pun) assert.equal(minuteReading(n), 'ぷん', `${n}分`);
  for (const n of fun) assert.equal(minuteReading(n), 'ふん', `${n}分`);
});

test('のこり時間は、秒を切り上げて出す（のこっているのに 0秒 と出さない）', () => {
  assert.deepEqual(splitRemaining(120), { minutes: 2, seconds: 0 });
  assert.deepEqual(splitRemaining(119.2), { minutes: 2, seconds: 0 });
  assert.deepEqual(splitRemaining(83.1), { minutes: 1, seconds: 24 });
  assert.deepEqual(splitRemaining(0.4), { minutes: 0, seconds: 1 });
  assert.deepEqual(splitRemaining(0), { minutes: 0, seconds: 0 });
  assert.deepEqual(splitRemaining(-2), { minutes: 0, seconds: 0 });
});

test('制限時間の書き方', () => {
  assert.equal(limitLabel(60), '1分');
  assert.equal(limitLabel(120), '2分');
  assert.equal(limitLabel(90), '1分30秒');
  assert.equal(limitLabel(45), '45秒');
});
