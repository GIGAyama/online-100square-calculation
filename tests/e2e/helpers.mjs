/*
 * 実ブラウザで動かすテスト（E2E）の共通の道具。
 *
 * 見ているのは「ビルドした結果（dist/）」。先に npm run build を走らせること。
 * 単体テスト（tests/*.test.mjs）と分けてあるのは、こちらはブラウザが要るため。
 *   npm test          … ブラウザなしで走る
 *   npm run test:e2e  … ブラウザで実際に操作する
 *
 * ⚠️ ここにあるテストは、どれも 2026-11-15 に実ブラウザで再現した不具合が元になっている。
 *    品質ゲート（npm run check）は文字列を読む検査なので、「押したら何が起きるか」は
 *    見えない。48 件ぜんぶ通っている状態で、下の不具合は残っていた。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = join(ROOT, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.woff2': 'font/woff2', '.bin': 'application/octet-stream',
};

/**
 * dist/ を配る小さなサーバー。空いているポートで立てる。
 * GitHub Pages と同じく cache-control: max-age=600 を付ける。
 * requests に「どのファイルが取られたか」が積まれていく。
 */
export async function startServer() {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/ がありません。先に npm run build を走らせてください');
  }
  const requests = [];
  // hangNavigation を true にすると、画面遷移の要求にだけ返事をしなくなる
  // （つながっているのに返事が来ない、混んだ校内 Wi-Fi の再現）
  const state = { hangNavigation: false };
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (state.hangNavigation && req.headers['sec-fetch-mode'] === 'navigate') return;
    requests.push(path);
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'max-age=600');
    res.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const close = () => new Promise((done) => {
    server.closeAllConnections();   // 返事をしていない接続が残っていると、いつまでも閉じない
    server.close(done);
  });
  return { url, requests, state, close };
}

/**
 * ブラウザを起こす。
 * Playwright の版と手元のブラウザの版が合わない環境（あらかじめブラウザが入っている
 * 開発用のコンテナなど）では、PW_CHROMIUM_PATH か /opt/pw-browsers/chromium を使う。
 */
export async function launchBrowser() {
  const explicit = process.env.PW_CHROMIUM_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit });
  try {
    return await chromium.launch();
  } catch (e) {
    const fallback = '/opt/pw-browsers/chromium';
    if (existsSync(fallback)) return chromium.launch({ executablePath: fallback });
    throw e;
  }
}

export const DEFAULT_SETTINGS = {
  sound: false, numpad: false, handwriting: false, autoScore: true, inputPosition: 'right',
};

/**
 * アプリを開く。settings は「はじめて開く前に端末に入っている設定」として置く。
 * Service Worker は、見たいテスト以外では止めておく（キャッシュが次のテストに残るため）。
 */
export async function openApp(browser, base, {
  settings = {}, viewport = { width: 1366, height: 768 }, serviceWorkers = 'block',
  initScript = null, hasTouch = false,
} = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((s) => {
    try {
      if (!localStorage.getItem('giga_calc_settings_v4')) {
        localStorage.setItem('giga_calc_settings_v4', JSON.stringify(s));
      }
    } catch (e) { /* 保存領域が使えない場面のテストでは、ここは失敗してよい */ }
  }, { ...DEFAULT_SETTINGS, ...settings });
  if (initScript) await page.addInitScript(initScript);
  await page.goto(base, { waitUntil: 'load' });
  return { context, page, errors };
}

export async function chooseAndStart(page, { mode, count } = {}) {
  await page.waitForSelector('table.sq-table');
  if (mode) await page.selectOption('select[aria-label="計算の種類"]', mode);
  if (count) await page.selectOption('select[aria-label="問題数"]', String(count));
  await page.getByRole('button', { name: 'スタート！' }).click();
  await page.waitForSelector('[data-game-state="playing"]');
  // はじめのマスへのフォーカスは、スタートの少しあとに当たる
  await page.waitForFunction(() => document.activeElement && document.activeElement.closest('table.sq-table'));
}

export const waitForState = (page, state) => page.waitForSelector(`[data-game-state="${state}"]`);

/** 盤面を読む（見出しの数・各マスの値と状態・枠のあるマス・フォーカスのあるマス） */
export function readBoard(page) {
  return page.evaluate(() => {
    const table = document.querySelector('table.sq-table');
    const head = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    const op = head[0];
    const cols = head.slice(1).map(Number);
    const rows = [];
    const cells = [];
    let active = null;
    let focused = null;
    [...table.querySelectorAll('tbody tr')].forEach((tr, r) => {
      rows.push(Number(tr.querySelector('th').textContent.trim()));
      [...tr.querySelectorAll('td')].forEach((td, c) => {
        const input = td.querySelector('input');
        if (td.className.includes('ring-2')) active = { r, c };
        if (document.activeElement === input) focused = { r, c };
        cells.push({
          r, c, val: input.value, disabled: input.disabled,
          correct: input.className.includes('cell-correct'),
          wrong: input.className.includes('cell-wrong'),
        });
      });
    });
    const remaining = document.body.innerText.match(/のこり\s*(\d+)/);
    return {
      op, cols, rows, cells, active, focused,
      remaining: remaining ? Number(remaining[1]) : null,
      // 'idle'（はじめる前）/ 'playing'（とりくみ中）/ 'result'（おわったあと）
      state: document.querySelector('[data-game-state]').dataset.gameState,
    };
  });
}

export const answerOf = (op, a, b) => (op === '+' ? a + b : op === '-' ? a - b : a * b);
export const answerAt = (board, r, c) => answerOf(board.op, board.rows[r], board.cols[c]);
export const cellAt = (board, r, c) => board.cells.find((cell) => cell.r === r && cell.c === c);

export async function clickCell(page, r, c) {
  await page.locator('table.sq-table tbody tr').nth(r).locator('td input').nth(c).click({ force: true });
}

export async function typeDigits(page, value) {
  for (const ch of String(value)) await page.keyboard.press(ch);
}

/** いまフォーカスのあるマスに、正しい答えを打つ */
export async function solveFocused(page) {
  const board = await readBoard(page);
  if (!board.focused) throw new Error('フォーカスのあるマスがありません');
  await typeDigits(page, answerAt(board, board.focused.r, board.focused.c));
}

/** 手書き欄の下に出る状態の文（ふりがなを除く） */
export function handwritingStatus(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('[role=status]')].find((e) => e.closest('.tool-column'));
    if (!el) return null;
    const copy = el.cloneNode(true);
    copy.querySelectorAll('rt,rp').forEach((n) => n.remove());
    return copy.textContent.trim();
  });
}

/**
 * 手書きの準備が済む（または失敗する）まで待って、状態の文を返す。
 * ⚠️ 画面の文字をそのまま探さないこと。ふりがなが漢字のあいだに入るので、
 *    「使えます」は画面上では「使つかえます」になり、いつまでも見つからない。
 */
export async function waitForHandwriting(page, timeout = 60000) {
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll('[role=status]')].find((e) => e.closest('.tool-column'));
    if (!el) return false;
    const copy = el.cloneNode(true);
    copy.querySelectorAll('rt,rp').forEach((n) => n.remove());
    return /使えます|失敗しました/.test(copy.textContent);
  }, null, { timeout });
  return handwritingStatus(page);
}
