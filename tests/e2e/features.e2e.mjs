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
