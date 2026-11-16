/*
 * あとから足した機能のテスト（タイムの分・秒、タイマーを隠す、だんを選ぶ、制限時間）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, launchBrowser, openApp, chooseAndStart, readBoard, waitForState,
  solveFocused, plainText, clickCell, typeDigits, answerAt,
} from './helpers.mjs';

let server;
let browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await server?.close(); });

const open = (options) => openApp(browser, server.url, options);

test('1分をこえたタイムは「2分5.3秒」のように、分と秒で出る', async () => {
  // 以前: 何分かかっても「125.3秒」と出ていた
  const { context, page } = await open({ fakeClock: true });
  try {
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    assert.match(await plainText(page, '[data-testid="clock"]'), /^\d+\.\d秒$/, '1分より前は秒だけ');

    await page.clock.fastForward(125_000);
    await page.waitForFunction(() => document.querySelector('[data-testid="clock"]').textContent.includes('分'));
    assert.match(await plainText(page, '[data-testid="clock"]'), /^2分\d+\.\d秒$/);

    for (let c = 0; c < 10; c++) await solveFocused(page);
    await waitForState(page, 'result');
    assert.match(await plainText(page, '[data-testid="result-time"]'), /^2分\d+\.\d秒$/, '結果のタイム');
    assert.match(await plainText(page, '[data-testid="clock"]'), /^2分\d+\.\d秒$/, '上のタイムも同じ形で止まる');

    await page.getByRole('button', { name: 'これまでの記録をみる' }).click();
    const stats = await plainText(page, '[role="dialog"]');
    assert.match(stats, /10問: ?2分\d+\.\d秒/, 'ベストタイムも分と秒で出る');
  } finally {
    await context.close();
  }
});

test('「タイマーを かくす」にすると、とりくんでいる間はタイムが出ない', async () => {
  const { context, page } = await open({ settings: { hideTimer: true } });
  try {
    await page.waitForSelector('table.sq-table');
    assert.equal(await page.locator('[data-testid="clock"]').count(), 0, 'はじめる前も出さない');
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    assert.equal(await page.locator('[data-testid="clock"]').count(), 0, 'とりくんでいる間は出さない');

    for (let c = 0; c < 10; c++) await solveFocused(page);
    await waitForState(page, 'result');
    assert.match(await plainText(page, '[data-testid="result-time"]'), /\d+\.\d秒$/, '終わったらタイムを出す');
    assert.equal(await page.locator('[data-testid="clock"]').count(), 1);
  } finally {
    await context.close();
  }
});

test('設定の「タイマーを かくす」を入れると、その場でタイムが消え、開き直しても残る', async () => {
  const { context, page } = await open();
  try {
    await page.waitForSelector('table.sq-table');
    assert.equal(await page.locator('[data-testid="clock"]').count(), 1);
    await page.getByRole('button', { name: '設定をひらく' }).click();
    await page.getByRole('dialog').getByText('タイマーを かくす').click();
    assert.equal(await page.locator('[data-testid="clock"]').count(), 0);

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('table.sq-table');
    assert.equal(await page.locator('[data-testid="clock"]').count(), 0, '設定は端末に残る');
  } finally {
    await context.close();
  }
});

test('かけ算で だんを えらぶと、えらんだ だんだけが出て、ベストタイムとは分けて残る', async () => {
  const { context, page } = await open();
  try {
    await page.waitForSelector('table.sq-table');
    const danButton = page.locator('[data-testid="dan-button"]');
    const countSelect = 'select[aria-label="問題数"]';
    assert.equal(await danButton.count(), 0, 'たし算のときは、だんのボタンを出さない');

    await page.selectOption('select[aria-label="計算の種類"]', 'かけ算');
    await page.selectOption(countSelect, '100');
    await danButton.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '7のだん' }).click();
    await dialog.getByRole('button', { name: 'きめる' }).click();

    assert.deepEqual((await readBoard(page)).rows, [7], '左には 7 だけが出る');
    assert.equal(await page.inputValue(countSelect), '10', '問題数は、えらんだ だんの数に合う');
    const disabledCounts = await page.evaluate((sel) => (
      [...document.querySelectorAll(`${sel} option`)].filter((o) => o.disabled).map((o) => o.value)
    ), countSelect);
    assert.deepEqual(disabledCounts, ['20', '30', '40', '50', '60', '70', '80', '90', '100'], '同じ行を 2 つは出さない');

    // だんを足す（7 はえらんだまま残っている）
    await danButton.click();
    await dialog.getByRole('button', { name: '6のだん' }).click();
    await dialog.getByRole('button', { name: '8のだん' }).click();
    await dialog.getByRole('button', { name: 'きめる' }).click();
    assert.deepEqual([...(await readBoard(page)).rows].sort(), [6, 7, 8]);
    assert.equal(await page.inputValue(countSelect), '30');
    assert.match(await danButton.innerText(), /6・7・8のだん/);

    await chooseAndStart(page);
    for (let i = 0; i < 30; i++) await solveFocused(page);
    await waitForState(page, 'result');

    const saved = await page.evaluate(() => ({
      records: JSON.parse(localStorage.getItem('giga_calc_records_v4'))['かけ算'],
      log: JSON.parse(localStorage.getItem('study.records.v1')).at(-1),
    }));
    assert.deepEqual(saved.records.history[0].dan, [6, 7, 8], '最近の記録には、どのだんだったかが残る');
    assert.deepEqual(saved.records.best, {}, 'だんをえらんだ回は、ベストタイムに入れない');
    assert.deepEqual(saved.log.ext.dan, [6, 7, 8], '学習ログにも残る');
    assert.equal(saved.log.unit.id, 'mul-30', '単元の ID は変えない');
    assert.equal(saved.log.ext.bestMs, null);
    assert.equal(saved.log.summary.firstTryCorrect, 30);

    await page.getByRole('button', { name: 'これまでの記録をみる' }).click();
    assert.match(await plainText(page, '[role="dialog"]'), /6・7・8のだん/);
    await page.keyboard.press('Escape');

    // ほかの計算に変えると、だんは効かない。かけ算へ戻すと、えらんだだんに合わせ直す
    await page.selectOption('select[aria-label="計算の種類"]', 'たし算');
    assert.equal(await danButton.count(), 0);
    await page.selectOption(countSelect, '100');
    assert.equal((await readBoard(page)).rows.length, 10);
    await page.selectOption('select[aria-label="計算の種類"]', 'かけ算');
    assert.equal(await page.inputValue(countSelect), '30', '100問のままにはしない');
    assert.deepEqual([...(await readBoard(page)).rows].sort(), [6, 7, 8]);

    // 「ぜんぶ はずす」で、もとの出し方にもどる
    await danButton.click();
    await dialog.getByRole('button', { name: 'ぜんぶ はずす' }).click();
    await dialog.getByRole('button', { name: 'きめる' }).click();
    assert.match(await danButton.innerText(), /ぜんぶ/);
    await page.selectOption(countSelect, '100');
    assert.equal(new Set((await readBoard(page)).rows).size, 10);
  } finally {
    await context.close();
  }
});

test('時間を決めると、時間になったところで終わり、「○分で ○問」が残る', async () => {
  const { context, page } = await open({ settings: { timeLimit: 60 }, fakeClock: true });
  try {
    await page.waitForSelector('table.sq-table');
    assert.equal(await plainText(page, '[data-testid="clock"]'), 'のこり1分', 'はじめる前は、決めてある時間を出す');

    await chooseAndStart(page, { mode: 'かけ算', count: 100 });
    for (let i = 0; i < 3; i++) await solveFocused(page);
    await page.clock.fastForward(30_000);
    await page.waitForFunction(() => /のこり\D*(29|30)/.test(document.querySelector('[data-testid="clock"]').textContent.replace(/びょう|ふん|ぷん/g, '')));
    assert.match(await plainText(page, '[data-testid="clock"]'), /^のこり(29|30)秒$/, 'のこり時間を数える');

    await page.clock.fastForward(31_000);
    await waitForState(page, 'result');
    assert.equal(await plainText(page, '[data-testid="result-timeup"]'), '1分 で 3問 できました');
    const board = await readBoard(page);
    assert.equal(board.cells.filter((cell) => cell.correct).length, 3);

    const saved = await page.evaluate(() => ({
      records: JSON.parse(localStorage.getItem('giga_calc_records_v4'))['かけ算'],
      log: JSON.parse(localStorage.getItem('study.records.v1')).at(-1),
    }));
    assert.equal(saved.records.history[0].limit, 60);
    assert.equal(saved.records.history[0].solved, 3);
    assert.deepEqual(saved.records.bestSolved, { 60: 3 }, '「1分で さいこう 3問」が残る');
    assert.deepEqual(saved.records.best, {}, 'ベストタイムには入れない（ぜんぶは解いていない）');

    assert.equal(saved.log.status, 'completed', '自分でやめたのではないので、中断にはしない');
    assert.equal(saved.log.ext.timeUp, true);
    assert.equal(saved.log.ext.timeLimitMs, 60000);
    assert.equal(saved.log.elapsedMs, 60000, '締める時刻は、制限時間ちょうど');
    assert.deepEqual(
      { count: saved.log.summary.count, attempted: saved.log.summary.attempted, correct: saved.log.summary.correct },
      { count: 100, attempted: 3, correct: 3 },
    );

    await page.getByRole('button', { name: 'これまでの記録をみる' }).click();
    const stats = await plainText(page, '[role="dialog"]');
    assert.match(stats, /1分で ?3問/, '最近の記録に出る');
    assert.match(stats, /さいこう ?1分: ?3問/, 'さいこうの数が出る');
    assert.doesNotMatch(stats, /とちゅうでやめた/, '中断の回数には数えない');
  } finally {
    await context.close();
  }
});

test('時間を決めていても、時間内に全部解ければ、いつもどおりクリアになる', async () => {
  const { context, page } = await open({ settings: { timeLimit: 60 }, fakeClock: true });
  try {
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    for (let i = 0; i < 10; i++) await solveFocused(page);
    await waitForState(page, 'result');
    assert.match(await plainText(page, '[data-testid="result-time"]'), /^\d+\.\d秒$/);
    assert.equal(await page.locator('[data-testid="result-timeup"]').count(), 0);

    // 終わったあとに時間が来ても、もう何も起きない
    await page.clock.fastForward(120_000);
    assert.equal(await page.locator('[data-testid="result-timeup"]').count(), 0);

    const saved = await page.evaluate(() => ({
      records: JSON.parse(localStorage.getItem('giga_calc_records_v4'))['たし算'],
      log: JSON.parse(localStorage.getItem('study.records.v1')),
    }));
    assert.ok(saved.records.best[10] > 0, 'ベストタイムに入る');
    assert.equal(saved.log.length, 1);
    assert.equal(saved.log[0].ext.timeLimitMs, 60000);
    assert.equal(saved.log[0].ext.timeUp, undefined);
  } finally {
    await context.close();
  }
});

test('すぐ判定オフでも、時間になれば、入れたところまでで丸つけをして終わる', async () => {
  const { context, page } = await open({ settings: { timeLimit: 60, autoScore: false, numpad: true }, fakeClock: true });
  try {
    await chooseAndStart(page, { mode: 'たし算', count: 20 });
    const board = await readBoard(page);
    // 2 マスは正しく、1 マスはまちがえて入れる
    await clickCell(page, 0, 0); await typeDigits(page, answerAt(board, 0, 0));
    await clickCell(page, 0, 1); await typeDigits(page, answerAt(board, 0, 1));
    await clickCell(page, 0, 2); await typeDigits(page, answerAt(board, 0, 2) + 1);
    await page.clock.fastForward(61_000);
    await waitForState(page, 'result');
    assert.equal(await plainText(page, '[data-testid="result-timeup"]'), '1分 で 2問 できました');
    const after = await readBoard(page);
    assert.equal(after.cells.filter((cell) => cell.correct).length, 2);
    assert.equal(after.cells.filter((cell) => cell.wrong).length, 1);
  } finally {
    await context.close();
  }
});

test('だんを 10 こ ぜんぶ えらんだときは、「ぜんぶ」と同じにあつかう', async () => {
  // 以前: 盤面は「ぜんぶ」と同じなのに、だんをえらんだ回としてベストタイムから外していた
  const { context, page } = await open();
  try {
    await page.waitForSelector('table.sq-table');
    await page.selectOption('select[aria-label="計算の種類"]', 'かけ算');
    const danButton = page.locator('[data-testid="dan-button"]');
    await danButton.click();
    const dialog = page.getByRole('dialog');
    for (let n = 0; n <= 9; n++) await dialog.getByRole('button', { name: `${n}のだん` }).click();
    await dialog.getByRole('button', { name: 'きめる' }).click();
    assert.match(await danButton.innerText(), /ぜんぶ/);

    await page.selectOption('select[aria-label="問題数"]', '10');
    await chooseAndStart(page);
    for (let i = 0; i < 10; i++) await solveFocused(page);
    await waitForState(page, 'result');
    const saved = await page.evaluate(() => ({
      records: JSON.parse(localStorage.getItem('giga_calc_records_v4'))['かけ算'],
      log: JSON.parse(localStorage.getItem('study.records.v1')).at(-1),
    }));
    assert.ok(saved.records.best[10] > 0, 'ベストタイムに入る');
    assert.equal(saved.log.ext.dan, undefined);
  } finally {
    await context.close();
  }
});

test('とりくんでいる間にタイムの字数がふえても、マスの表の位置は動かない', async () => {
  // 以前: 幅によっては、1分になった瞬間や「のこり」の表示が変わった瞬間にヘッダーが折り返し、
  //       マスの表が 39px 下へ動いた
  const tableTop = (page) => page.evaluate(() => Math.round(document.querySelector('table.sq-table').getBoundingClientRect().top));
  for (const [width, settings, advance] of [
    [652, {}, 61_000],                       // 59.9秒 → 1分0.0秒
    [686, { timeLimit: 120 }, 2_000],        // のこり 2分0秒 → のこり 1分59秒
    [790, { timeLimit: 600 }, 2_000],        // のこり 10分0秒 → のこり 9分59秒
  ]) {
    const { context, page } = await open({ settings, viewport: { width, height: 900 }, fakeClock: true });
    try {
      await chooseAndStart(page, { mode: 'たし算', count: 10 });
      const before = await tableTop(page);
      await page.clock.fastForward(advance);
      await page.waitForTimeout(200);
      assert.equal(await tableTop(page), before, `幅 ${width}px`);
    } finally {
      await context.close();
    }
  }
});
