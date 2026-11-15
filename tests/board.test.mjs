/*
 * 盤面の作り方（src/board.js）のテスト。ブラウザなしで走る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shuffle, rowPool, makeCols, pickRows } from '../src/board.js';

const sorted = (list) => [...list].sort((a, b) => a - b);
const zeroToNine = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const tenToNineteen = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

test('100問（10行）なら、左の数は 0〜9 が 1 回ずつ出る', () => {
  // 以前は 1 行ずつ乱数で選んでいたので、同じ数の行が重なり、
  // 100 通りのうち平均 65 通りしか出ていなかった
  for (let i = 0; i < 300; i++) {
    assert.deepEqual(sorted(pickRows('たし算', 10)), zeroToNine);
    assert.deepEqual(sorted(pickRows('かけ算', 10)), zeroToNine);
    assert.deepEqual(sorted(pickRows('引き算', 10)), tenToNineteen);
  }
});

test('行数が少なくても、同じ数は重ならない', () => {
  for (let rows = 1; rows <= 10; rows++) {
    for (let i = 0; i < 100; i++) {
      const picked = pickRows('かけ算', rows);
      assert.equal(picked.length, rows);
      assert.equal(new Set(picked).size, rows, `${rows}行: ${picked.join(',')}`);
      for (const n of picked) assert.ok(zeroToNine.includes(n));
    }
  }
});

test('並びは毎回かわる（いつも同じ順にならない）', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(pickRows('たし算', 10).join(','));
  assert.ok(seen.size > 40, `50 回で ${seen.size} 通り`);
});

test('上の数は、いつも 0〜9 を並べかえた 10 個', () => {
  for (let i = 0; i < 100; i++) assert.deepEqual(sorted(makeCols()), zeroToNine);
});

test('引き算の左は 10〜19、ほかは 0〜9', () => {
  assert.deepEqual(rowPool('引き算'), tenToNineteen);
  assert.deepEqual(rowPool('たし算'), zeroToNine);
  assert.deepEqual(rowPool('かけ算'), zeroToNine);
});

test('シャッフルは、もとの配列を変えず、中身を増やしも減らしもしない', () => {
  const original = [1, 2, 3, 4, 5];
  const copy = [...original];
  const result = shuffle(original);
  assert.deepEqual(original, copy);
  assert.deepEqual(sorted(result), copy);
});

test('乱数を渡せば、同じ並びを作り直せる', () => {
  const fixed = () => {
    let seed = 42;
    return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  };
  assert.deepEqual(pickRows('かけ算', 10, fixed()), pickRows('かけ算', 10, fixed()));
});
