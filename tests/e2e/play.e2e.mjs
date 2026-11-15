/*
 * マスを解く操作のテスト。
 * どれも 2026-11-15 に実ブラウザで再現した不具合が元になっている。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, launchBrowser, openApp, chooseAndStart, readBoard, waitForState,
  answerAt, cellAt, clickCell, typeDigits, solveFocused,
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
