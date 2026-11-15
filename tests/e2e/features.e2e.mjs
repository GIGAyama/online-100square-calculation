/*
 * あとから足した機能のテスト（タイムの分・秒、タイマーを隠す、だんを選ぶ、制限時間）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, launchBrowser, openApp, chooseAndStart, readBoard, waitForState,
  solveFocused, plainText,
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
