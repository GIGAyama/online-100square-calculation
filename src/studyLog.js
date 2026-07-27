/* study.v1 共通学習ログ — 保存のみ。外部送信は行わない。 */
/*
 * 仕様: 学習ログ共通スキーマ仕様書 `study.v1`（GIGA山 学習アプリ群）
 * 配布形態: ESM / ロジック版 1.1（仕様書 §5.1.2 の参照実装に対応）
 *
 * このファイルは全アプリで同一の動作とすること。
 * コメントや形式（ESM / グローバル）の差異は許容するが、ロジック本体の版ずれは
 * 許容しない。改訂したら §5.1.3 の配布状況追跡表を更新し、全アプリへ配り直す。
 *
 * 保存先キー `study.records.v1` は複数アプリ共通の学習ログです。
 * このアプリ専用のキーではないため、リセット処理やクリーンアップの対象に
 * 含めないでください（仕様書 §1.1 / §1.2）。
 */
const STUDY_LOG_KEY = 'study.records.v1';
const STUDY_LOG_MAX = 500;
const STUDY_ITEMS_MAX = 200;

const uuid = () =>
  (crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }));

const sanitizeWrong = (v) =>
  typeof v === 'string' && v.length <= 12 && !/[<>{}\\]/.test(v) ? v : null;

export function saveStudyRecord(rec) {
  try {
    // 必須項目の検証
    if (!rec || !rec.appId || !rec.unit || !rec.unit.id) return null;
    if (typeof rec.elapsedMs !== 'number' || rec.elapsedMs < 0) return null;
    if (!rec.summary || typeof rec.summary.count !== 'number') return null;

    const items = Array.isArray(rec.items)
      ? rec.items.slice(0, STUDY_ITEMS_MAX).map((it) => ({
          ...it,
          wrong: Array.isArray(it.wrong)
            ? it.wrong.map(sanitizeWrong).filter(Boolean)
            : undefined,
        }))
      : undefined;

    const entry = {
      schema: 'study.v1',
      id: uuid(),
      kind: 'session',
      source: 'course',
      multiplayer: false,
      grading: 'objective',
      status: 'completed',
      timeBasis: 'app',
      ...rec,
      items,
      elapsedMs: Math.round(rec.elapsedMs),
    };

    // 保存済みログの読み出し。
    // 中身が壊れている（JSON として読めない／配列でない）場合は空からやり直す。
    // ここで外側の catch に流すと、一度壊れた端末は以降ずっと1件も保存できなくなる。
    const raw = localStorage.getItem(STUDY_LOG_KEY);
    let log = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) log = parsed;
      } catch (e) { /* 壊れていた → 空からやり直す */ }
    }

    log.push(entry);
    if (log.length > STUDY_LOG_MAX) log.splice(0, log.length - STUDY_LOG_MAX);
    localStorage.setItem(STUDY_LOG_KEY, JSON.stringify(log));
    return entry.id;
  } catch (e) {
    // 保存失敗はアプリの動作を妨げない
    console.warn('[studyLog] save failed', e);
    return null;
  }
}
