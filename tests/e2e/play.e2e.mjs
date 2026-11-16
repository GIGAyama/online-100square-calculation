/*
 * マスを解く操作のテスト。
 * どれも 2026-11-15 に実ブラウザで再現した不具合が元になっている。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, launchBrowser, openApp, chooseAndStart, readBoard, waitForState,
  answerAt, cellAt, clickCell, typeDigits, solveFocused, waitForHandwriting,
} from './helpers.mjs';

let server;
let browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await server?.close(); });

const open = (options) => openApp(browser, server.url, options);

test('マスを飛ばして最後まで解くと、枠が飛ばしたマスへ戻り、正解ずみの答えは消えない', async () => {
  // 以前: 枠が正解ずみの最後のマスに残り、テンキーを押すとその答えが消えた（のこり 1問 → 2問）
  const { context, page } = await open({ settings: { numpad: true } });
  try {
    await chooseAndStart(page, { mode: 'かけ算', count: 10 });
    await page.keyboard.press('Enter');                 // 先頭のマスを飛ばす
    for (let c = 1; c <= 9; c++) await solveFocused(page);
    await page.waitForFunction(() => document.body.innerText.match(/のこり\s*1/));

    let board = await readBoard(page);
    assert.deepEqual(board.active, { r: 0, c: 0 }, '枠は、飛ばした先頭のマスへ戻る');
    assert.deepEqual(board.focused, { r: 0, c: 0 }, 'フォーカスも同じマスにある');
    const last = String(answerAt(board, 0, 9));
    assert.equal(cellAt(board, 0, 9).val, last);

    // 先頭のマスの答えとはちがう数字を、テンキーで 1 つ押す
    const wrongDigit = String(answerAt(board, 0, 0)).startsWith('5') ? '6' : '5';
    await page.getByRole('button', { name: wrongDigit, exact: true }).click();
    board = await readBoard(page);
    assert.equal(cellAt(board, 0, 9).val, last, '正解ずみの最後のマスは、そのまま残る');
    assert.equal(board.state, 'playing');
  } finally {
    await context.close();
  }
});

test('矢印キーは正解ずみのマスを飛ばし、枠とフォーカスが食い違わない', async () => {
  // 以前: ← を何回押しても枠が 1 マスしか動かず、打った数字は枠と別のマスに入った
  const { context, page } = await open();
  try {
    await chooseAndStart(page, { mode: 'たし算', count: 30 });
    await solveFocused(page);                           // (0,0)
    await solveFocused(page);                           // (0,1)
    await page.keyboard.press('Enter');                 // (0,2) を飛ばす
    await solveFocused(page);                           // (0,3)
    await solveFocused(page);                           // (0,4) → いま (0,5)
    await page.keyboard.press('ArrowLeft');

    let board = await readBoard(page);
    assert.deepEqual(board.active, { r: 0, c: 2 }, '正解ずみの (0,4)(0,3) を飛ばして、飛ばしたマスへ戻る');
    assert.deepEqual(board.focused, board.active, '枠とフォーカスは同じマス');

    await typeDigits(page, answerAt(board, 0, 2));
    board = await readBoard(page);
    assert.ok(cellAt(board, 0, 2).disabled, '打った答えは、枠のあったマスに入って正解になる');
    assert.deepEqual(board.focused, board.active);

    // ↑ も同じ。上のマスが正解ずみなら、その先の入力できるマスまで動く
    await clickCell(page, 2, 0);
    await page.keyboard.press('ArrowUp');
    board = await readBoard(page);
    assert.deepEqual(board.active, { r: 1, c: 0 }, 'すぐ上の (1,0) は未回答なので、そこへ動く');
    await typeDigits(page, answerAt(board, 1, 0));
    await clickCell(page, 2, 0);
    await page.keyboard.press('ArrowUp');
    board = await readBoard(page);
    assert.deepEqual(board.active, { r: 2, c: 0 }, '上が全部正解ずみなら、動かない');
    assert.deepEqual(board.focused, board.active);

    // → は表の最後から先頭へ戻って、残っているマスを探す
    await clickCell(page, 2, 9);
    await page.keyboard.press('ArrowRight');
    board = await readBoard(page);
    assert.deepEqual(board.active, { r: 0, c: 5 }, '先頭から読む順で、最初に残っているマス');
  } finally {
    await context.close();
  }
});

test('すぐ判定オフ・手書きだけ: 桁の足りない答えで全部うまっても「丸つけ する」で終われる', async () => {
  // 以前: 「のこり 0問」のまま採点が始まらず、手書きだけの端末では終われなかった
  const { context, page } = await open({ settings: { autoScore: false, handwriting: true } });
  try {
    await chooseAndStart(page, { mode: '引き算', count: 10 });
    let board = await readBoard(page);
    // 引き算は「10〜19 − 0」のマスが必ず 2 けたになる。そこを最後に残す
    const twoDigit = board.cells.find((cell) => answerAt(board, cell.r, cell.c) >= 10);
    for (const cell of board.cells) {
      if (cell === twoDigit) continue;
      await clickCell(page, cell.r, cell.c);
      await typeDigits(page, answerAt(board, cell.r, cell.c));
    }
    await clickCell(page, twoDigit.r, twoDigit.c);
    await typeDigits(page, '9');                        // 正しくは 2 けた

    board = await readBoard(page);
    assert.equal(board.remaining, 0, '全部のマスに何か入っている');
    assert.equal(board.state, 'playing', '桁が足りないので、まだ採点は始まらない');

    await page.getByRole('button', { name: /つけ する/ }).click();
    await waitForState(page, 'result');
    board = await readBoard(page);
    assert.ok(cellAt(board, twoDigit.r, twoDigit.c).wrong, '桁の足りなかったマスは「まちがい」になる');
    assert.equal(board.cells.filter((cell) => cell.correct).length, 9);
  } finally {
    await context.close();
  }
});

test('すぐ判定オフ: 空いているマスを残して「丸つけ する」を押すと、一度たずねる', async () => {
  const { context, page } = await open({ settings: { autoScore: false, numpad: true } });
  try {
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    let board = await readBoard(page);
    for (let c = 0; c < 3; c++) {
      await clickCell(page, 0, c);
      await typeDigits(page, answerAt(board, 0, c));
    }
    const gradeButton = page.locator('.tool-column').getByRole('button', { name: /つけ する/ });
    await gradeButton.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /7マス/, '空いているマスの数を出す');

    await dialog.getByRole('button', { name: 'つづける' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await readBoard(page)).state, 'playing', '「つづける」なら終わらない');

    await gradeButton.click();
    await dialog.getByRole('button', { name: /つけ する/ }).click();
    await waitForState(page, 'result');
    board = await readBoard(page);
    assert.equal(board.cells.filter((cell) => cell.correct).length, 3);

    // 空いているマスを残した丸つけは、完走ではない。学習ログでは 'aborted' にする
    // （1.8.0 では completed にしていたので、1 マスだけ答えて丸つけすると、
    //   まなびクエストに数秒の「完走」タイムが自己ベストとして残った）
    const log = await page.evaluate(() => JSON.parse(localStorage.getItem('study.records.v1')).at(-1));
    assert.equal(log.status, 'aborted');
    assert.equal(log.summary.attempted, 3);
  } finally {
    await context.close();
  }
});

test('手書き欄の「次へ」で、マスを押さなくても次のマスへ進める', async () => {
  // 手書きだけの端末には Enter もテンキーの「次へ」も無い
  const { context, page } = await open({ settings: { handwriting: true } });
  try {
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    assert.deepEqual((await readBoard(page)).active, { r: 0, c: 0 });
    await page.getByRole('button', { name: 'つぎのマスへすすむ' }).click();
    const board = await readBoard(page);
    assert.deepEqual(board.active, { r: 0, c: 1 });
    assert.deepEqual(board.focused, board.active);
  } finally {
    await context.close();
  }
});

test('左の数は重ならない。100問なら 0〜9（引き算は 10〜19）が 1 回ずつ出る', async () => {
  // 以前: 1 行ずつ乱数で選んでいたので同じ数の行が重なり、100 通りのうち平均 65 通りしか出なかった
  const { context, page } = await open();
  try {
    await page.waitForSelector('table.sq-table');
    const sorted = (list) => [...list].sort((a, b) => a - b);
    for (const [mode, expected] of [
      ['たし算', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
      ['かけ算', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
      ['引き算', [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]],
    ]) {
      await page.selectOption('select[aria-label="計算の種類"]', mode);
      await page.selectOption('select[aria-label="問題数"]', '100');
      assert.deepEqual(sorted((await readBoard(page)).rows), expected, `${mode} 100問`);
      await page.selectOption('select[aria-label="問題数"]', '40');
      const rows = (await readBoard(page)).rows;
      assert.equal(new Set(rows).size, 4, `${mode} 40問: ${rows.join(',')}`);
    }
  } finally {
    await context.close();
  }
});

// ---- ここから下は、1.8.0 を出したあとの見直しで見つかったもの（2026-11-16） ----

/** 手書きの左のわくに、たての線（1）を 1 本書く。指を離した直後に戻る */
async function drawOne(page) {
  const box = await page.locator('canvas').first().boundingBox();
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.move(x, box.y + box.height * 0.8, { steps: 4 });
  await page.mouse.up();
}

test('手書きで書いてすぐ「次へ」を押しても、書いた答えは捨てられない', async () => {
  // 以前: 読み取りは指を離して 0.4 秒後。その前に「次へ」を押すと、読み取りの予約ごと
  //       線が消えて、マスは空のまま枠だけ進んだ（すぐ判定オフでは、毎マス通る道）
  const { context, page } = await open({ settings: { handwriting: true, autoScore: false } });
  try {
    await page.waitForSelector('table.sq-table');
    await waitForHandwriting(page);
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    await drawOne(page);
    await page.getByRole('button', { name: 'つぎのマスへすすむ' }).click();   // 0.4 秒たつ前に押す
    await page.waitForTimeout(700);
    const board = await readBoard(page);
    assert.match(cellAt(board, 0, 0).val, /^\d+$/, '書いた数字が、もとのマスに入っている');
    assert.deepEqual(board.active, { r: 0, c: 1 }, '枠は、となりへ 1 つだけ進む');
  } finally {
    await context.close();
  }
});

test('手書きで書いてすぐ「丸つけ する」を押しても、書いた答えは数に入る', async () => {
  const { context, page } = await open({ settings: { handwriting: true, autoScore: false } });
  try {
    await page.waitForSelector('table.sq-table');
    await waitForHandwriting(page);
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    await drawOne(page);
    await page.locator('.tool-column').getByRole('button', { name: /つけ する/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /9マス/, '書いた 1 マスは「入れた」に数える（空きは 9）');
  } finally {
    await context.close();
  }
});

test('手書きで書いてすぐ別のマスを押しても、書いた答えは捨てられない', async () => {
  const { context, page } = await open({ settings: { handwriting: true, autoScore: false } });
  try {
    await page.waitForSelector('table.sq-table');
    await waitForHandwriting(page);
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    await drawOne(page);
    await clickCell(page, 0, 5);
    await page.waitForTimeout(700);
    const board = await readBoard(page);
    assert.match(cellAt(board, 0, 0).val, /^\d+$/, '書いた数字が、書いていたマスに入っている');
    assert.equal(cellAt(board, 0, 5).val, '', '押した先のマスには入らない');
    assert.deepEqual(board.active, { r: 0, c: 5 });
  } finally {
    await context.close();
  }
});

test('正解ずみのマスを押しても、枠とフォーカスは動かず、そのまま入力をつづけられる', async () => {
  // 以前: 枠だけが正解ずみのマスへ移り、フォーカスはどのマスにも無くなった。
  //       テンキーもキーボードも効かず、未回答のマスを押すまで何も入らなかった
  const { context, page } = await open({ settings: { numpad: true } });
  try {
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    await solveFocused(page);                           // (0,0) を解く → いま (0,1)
    await page.locator('table.sq-table tbody tr').nth(0).locator('td').nth(0).click({ force: true });
    let board = await readBoard(page);
    assert.deepEqual(board.active, { r: 0, c: 1 }, '枠は、解いているマスのまま');
    assert.deepEqual(board.focused, { r: 0, c: 1 }, 'フォーカスも、解いているマスのまま');

    const answer = String(answerAt(board, 0, 1));
    for (const ch of answer) await page.getByRole('button', { name: ch, exact: true }).click();
    board = await readBoard(page);
    assert.ok(cellAt(board, 0, 1).disabled, 'テンキーの数字は、解いているマスに入る');
  } finally {
    await context.close();
  }
});

test('すぐ判定オフ: 桁の足りないまちがいも、学習ログに「まちがい」として残る', async () => {
  // 以前: 答えの桁数まで入れたときしか「答えた」と数えていなかった。2 けたの答えに
  //       1 けたを入れたマスは記録から抜け、まちがえているのに「一発で正解できた率 100%」になった
  const { context, page } = await open({ settings: { autoScore: false, numpad: true } });
  try {
    await chooseAndStart(page, { mode: '引き算', count: 10 });
    const board = await readBoard(page);
    let short = 0;
    for (const cell of board.cells) {
      const answer = answerAt(board, cell.r, cell.c);
      await clickCell(page, cell.r, cell.c);
      // 答えが 2 けたのマスのうち 1 つには、1 けたの数を入れる（引き算は「−0」のマスが必ず 2 けた）
      if (answer >= 10 && short === 0) { await typeDigits(page, '9'); short += 1; } else await typeDigits(page, answer);
    }
    const stillPlaying = (await readBoard(page)).state === 'playing';
    if (stillPlaying) await page.locator('.tool-column').getByRole('button', { name: /つけ する/ }).click();
    await waitForState(page, 'result');

    const log = await page.evaluate(() => JSON.parse(localStorage.getItem('study.records.v1')).at(-1));
    assert.equal(log.summary.attempted, 10, '答えを入れた 10 マスぜんぶを数える');
    assert.equal(log.summary.correct, 9);
    assert.equal(log.summary.firstTryCorrect, 9, 'まちがえたマスは、一発で正解に入れない');
    assert.equal(log.ext.wrongItems.length, 1);
    assert.equal(log.status, 'completed', '全部のマスに答えを入れてから丸つけした回は、完走');
    const wrong = log.items.filter((item) => !item.ok);
    assert.equal(wrong.length, 1);
    assert.deepEqual(wrong[0].wrong, ['9']);
  } finally {
    await context.close();
  }
});
