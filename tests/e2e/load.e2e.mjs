/*
 * 読み込み・圏外・保存まわりのテスト。
 * どれも 2026-11-15 に実ブラウザで再現した不具合が元になっている。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, launchBrowser, openApp, chooseAndStart, readBoard, waitForState,
  solveFocused, waitForHandwriting,
} from './helpers.mjs';

let server;
let browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await server?.close(); });
beforeEach(() => { server.requests.length = 0; server.state.hangNavigation = false; });

const open = (options) => openApp(browser, server.url, options);
const tfjsRequests = () => server.requests.filter((path) => /tfjs/.test(path));

test('手書きをオフにした端末は、TensorFlow.js を取りにいかない', async () => {
  // 以前: 入口の JS が tfjs の束を静的に import していて、設定に関係なく 1.4MB を読んでいた
  const { context, page } = await open({ settings: { handwriting: false, numpad: true } });
  try {
    await page.waitForSelector('table.sq-table');
    await page.waitForTimeout(1500);
    assert.deepEqual(tfjsRequests(), []);
  } finally {
    await context.close();
  }
});

test('手書きをオンにした端末は、マスを出したあとで TensorFlow.js を読む', async () => {
  const { context, page } = await open({ settings: { handwriting: true } });
  try {
    await page.waitForSelector('table.sq-table');
    assert.match(await waitForHandwriting(page), /使えます/);
    assert.equal(tfjsRequests().length, 1);
  } finally {
    await context.close();
  }
});

test('保存領域に書けない端末でも、画面が出て最後まで解ける', async () => {
  // 以前: localStorage への書き込みが失敗すると、画面ごと外れて真っ白になった
  const cases = {
    '容量がいっぱいで書けない': () => {
      Storage.prototype.setItem = function setItem() { throw new DOMException('quota', 'QuotaExceededError'); };
    },
    'サイトデータの保存を止めてある': () => {
      Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('denied', 'SecurityError'); },
      });
    },
  };
  for (const [name, initScript] of Object.entries(cases)) {
    const { context, page, errors } = await open({ initScript });
    try {
      await chooseAndStart(page, { mode: 'たし算', count: 10 });
      for (let c = 0; c < 10; c++) await solveFocused(page);
      await waitForState(page, 'result');
      assert.deepEqual(errors, [], `${name}: ページのエラーが出ない`);
    } finally {
      await context.close();
    }
  }
});

test('横に長い手書き欄でも、線が太くなりすぎない', async () => {
  // 以前: 線の太さを欄の「幅」で決めていたので、iPad の縦向きでは 40.7px（欄の高さの 27%）
  //       になり、字がつぶれて読みとれなかった
  const { context, page } = await open({
    settings: { handwriting: true }, viewport: { width: 810, height: 1080 },
  });
  try {
    await chooseAndStart(page, { mode: 'たし算', count: 10 });
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    assert.ok(box.width > box.height * 1.5, `欄が横に長い画面で測る（${Math.round(box.width)}×${Math.round(box.height)}）`);

    // 欄のまんなかに横線を 1 本引く
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.7, y, { steps: 5 });
    // 指を離す前に測る（離すと読み取りが走って線が消える）
    const ratio = await page.evaluate(() => {
      const el = document.querySelector('canvas');
      const ctx = el.getContext('2d');
      const column = ctx.getImageData(Math.floor(el.width / 2), 0, 1, el.height).data;
      let dark = 0;
      for (let i = 0; i < el.height; i++) if (column[i * 4] < 128) dark++;
      return dark / el.height;
    });
    await page.mouse.up();
    assert.ok(ratio > 0.05, `線が引けている（欄の高さの ${(ratio * 100).toFixed(0)}%）`);
    assert.ok(ratio < 0.16, `線の太さは欄の高さの 16% 未満（実際は ${(ratio * 100).toFixed(0)}%）`);
  } finally {
    await context.close();
  }
});

test('オンラインで 1 回開いただけの端末でも、圏外で開けて手書きが使える', async () => {
  // 以前: (1) 入口の JS が tfjs の束ごと読めずに真っ白  (2) 直しても、tfjs は 2 回開くまで
  //       キャッシュに入らず「AIの準備に失敗しました」になった
  const { context, page } = await open({ settings: { handwriting: true }, serviceWorkers: 'allow' });
  try {
    await page.waitForSelector('table.sq-table');
    await page.evaluate(() => navigator.serviceWorker.ready);
    assert.match(await waitForHandwriting(page), /使えます/);
    // 「取ったものを控えて」という合図が Service Worker に届き、控え終わるまで待つ
    await page.waitForFunction(async () => {
      for (const name of await caches.keys()) {
        const keys = await (await caches.open(name)).keys();
        if (keys.some((request) => /tfjs/.test(request.url))) return true;
      }
      return false;
    }, null, { timeout: 30000, polling: 250 });

    // GitHub Pages の max-age=600 が切れたあとを再現するため、HTTP キャッシュを空にする
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });

    await page.waitForSelector('table.sq-table');
    assert.match(await waitForHandwriting(page), /使えます/, '圏外でも手書きの準備ができる');
  } finally {
    await context.close();
  }
});

test('返事の来ない回線でも、入れてある端末は数秒でマスが出る', async () => {
  // 以前: 画面遷移は回線の返事を待ちつづけ、40 秒待ってもマスが出なかった（圏外なら 0.1 秒）
  const { context, page } = await open({ serviceWorkers: 'allow' });
  try {
    await page.waitForSelector('table.sq-table');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' });            // Service Worker の管理下に入れる
    await page.waitForSelector('table.sq-table');
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller));

    server.state.hangNavigation = true;
    const started = Date.now();
    await page.reload({ waitUntil: 'commit', timeout: 20000 });
    await page.waitForSelector('table.sq-table', { timeout: 20000 });
    const seconds = (Date.now() - started) / 1000;
    assert.ok(seconds < 8, `返事を待つのは 3 秒まで（実際は ${seconds.toFixed(1)} 秒）`);
  } finally {
    server.state.hangNavigation = false;
    await context.close();
  }
});
