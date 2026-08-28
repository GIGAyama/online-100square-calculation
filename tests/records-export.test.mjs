// 学習ログの受け渡し口の検査。
//
// ここは「誰に渡してよいか」を決めている場所なので、
// 通してはいけない相手を1つでも通すと学習ログがよそへ渡る。
// 正しく通る例より、通ってはいけない例のほうを厚く並べてある。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 受け渡し口の置き場はリポジトリによって違う（js/ と public/ の2通りある）。
 *
 * ⚠️ 以前はここに '../js/records-export.js' と書いてあった。
 *    public/ に置いている 3 本（KANJI_Town・Qalc・online-100square-calculation）では
 *    npm test が ERR_MODULE_NOT_FOUND で落ちる。にもかかわらず check-drift は緑だった。
 *    対応表の normalize（records-export-import）が、この import 行を
 *    プレースホルダーに潰してから比べていたためである。
 *    「配布先ごとに直してよい」という顔をしていたが、distribute.mjs は
 *    normalize を見ずに正本をそのまま上書きするので、配布先で直しても次の配布で消える。
 *    ずらしてよい場所を作るのではなく、置き場を実行時に探して 1 枚で両方に効かせる。
 */
// './' は正本そのもの（standards/records/）。ポータルでも自分の正本を試せるようにする
const CANDIDATES = ['../js/records-export.js', '../public/records-export.js', './records-export.js'];
const found = CANDIDATES.find((rel) => existsSync(fileURLToPath(new URL(rel, import.meta.url))));
if (!found) {
  throw new Error(`records-export.js が見つかりません（探した場所: ${CANDIDATES.join(' / ')}）`);
}
const { isAllowedOrigin, parseRecords } = await import(found);

test('giga-school.com とそのサブドメインには渡す', () => {
  for (const o of [
    'https://giga-school.com',              // 集計ページの置き場
    'https://kake-master.giga-school.com',  // 各アプリのサブドメイン
    'https://kanji-town.giga-school.com',
    'https://online-100square-calculation.giga-school.com',  // 長い slug
  ]) {
    assert.equal(isAllowedOrigin(o), true, o);
  }
});

test('よそのサイトには渡さない', () => {
  for (const o of [
    // 前方一致・後方一致で書くと、この2つが通ってしまう
    'https://giga-school.com.example.com',
    'https://evil-giga-school.com',
    // 見た目が近いだけの別ドメイン
    'https://giga-school.net',
    'https://gigaschool.com',
    // 別オリジンになる組み合わせ
    'http://giga-school.com',               // https でない
    'https://giga-school.com:8443',         // ポートが違う
    'https://gigayama.github.io',           // 旧オリジン
    // 値として壊れているもの
    'null',                                 // sandbox iframe の origin
    '',
    undefined,
    null,
    { toString: () => 'https://giga-school.com' },
  ]) {
    assert.equal(isAllowedOrigin(o), false, String(o));
  }
});

test('手元で確かめるための localhost は通す', () => {
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8080'), true);
  // localhost に見せかけた別ドメインは通さない
  assert.equal(isAllowedOrigin('http://localhost.evil.com'), false);
});

test('記録が読めないときは空の配列を返し、集計側を落とさない', () => {
  assert.deepEqual(parseRecords(null), []);
  assert.deepEqual(parseRecords(''), []);
  assert.deepEqual(parseRecords('{壊れたJSON'), []);
  // 配列以外が入っていても、そのまま返さない
  assert.deepEqual(parseRecords('{"a":1}'), []);
  assert.deepEqual(parseRecords('"文字列"'), []);
});

test('読める記録はそのまま返す', () => {
  const records = [{ schema: 'study.v1', appId: '__APP_ID__', mode: 'quiz' }];
  assert.deepEqual(parseRecords(JSON.stringify(records)), records);
});
