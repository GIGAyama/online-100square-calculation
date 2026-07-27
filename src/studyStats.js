/*
 * study.v1 学習ログの「読み出し側」ユーティリティ（このアプリ専用 / §5.5）
 *
 * 保存側（studyLog.js）は全アプリ共通・同一ロジックとする決まりのため、
 * 集計・表示のためのコードはこちらに分離している。
 *
 * 遵守事項（§5.5）
 * - 読み出し専用。`study.records.v1` への書き込み・削除を行わない
 * - 自アプリの appId でフィルタする。他アプリのレコードを表示しない
 * - schema === 'study.v1' を確認する
 * - パース失敗時は空配列を返し、アプリの表示を壊さない
 * - multiplayer: true のレコードは学力指標から除外する
 */
const STUDY_LOG_KEY = 'study.records.v1';

/** 自アプリのレコードだけを新しい順に読み出す */
export function loadStudyRecords(appId) {
  try {
    const raw = localStorage.getItem(STUDY_LOG_KEY);
    if (!raw) return [];
    const log = JSON.parse(raw);
    if (!Array.isArray(log)) return [];
    return log
      .filter((r) => r && r.schema === 'study.v1' && r.appId === appId)
      .reverse();
  } catch (e) {
    console.warn('[studyStats] load failed', e);
    return [];
  }
}

/**
 * モード（add / sub / mul）ごとに集計する。
 * 正答率は仕様どおり firstTryCorrect（初回正答）を主指標とし、
 * 分母には count ではなく attempted を用いる（§5.5）。
 * count で割ると、中断して手をつけていない問題まで「間違えた」ことになる。
 */
export function summarizeByMode(records, recentCount = 10) {
  const byMode = {};
  for (const r of records) {
    const mode = r.mode;
    if (!mode) continue;
    if (!byMode[mode]) {
      byMode[mode] = {
        sessions: 0,
        aborted: 0,
        totalMs: 0,
        activeMs: 0,
        recent: [],
        weak: new Map(),
      };
    }
    const m = byMode[mode];
    // 取り組み量（回数・時間）は multiplayer でも数える
    m.sessions++;
    if (r.status === 'aborted') m.aborted++;
    if (typeof r.elapsedMs === 'number') m.totalMs += r.elapsedMs;
    if (typeof r.activeMs === 'number') m.activeMs += r.activeMs;

    // 妨害要素や盤面戦略により正誤が学力を反映しないため、
    // 学力指標（正答率・にがて判定）からは除外する（§5.5）
    if (r.multiplayer === true) continue;

    // records は新しい順なので、先頭 recentCount 件が「さいきん」
    if (m.recent.length < recentCount) m.recent.push(r);

    if (Array.isArray(r.items)) {
      for (const it of r.items) {
        if (!it || it.firstTry !== false || !it.q) continue;
        // 同じ q が1レコード内に複数現れうる（行の値は重複しうる）。
        // 別々の試行として数える（§2.10）
        m.weak.set(it.q, (m.weak.get(it.q) || 0) + 1);
      }
    }
  }

  const out = {};
  for (const [mode, m] of Object.entries(byMode)) {
    let attempted = 0;
    let firstTryCorrect = 0;
    for (const r of m.recent) {
      const s = r.summary || {};
      // attempted を持たない古いレコードは count で代替する
      const a = typeof s.attempted === 'number' ? s.attempted : s.count;
      if (typeof a === 'number') attempted += a;
      if (typeof s.firstTryCorrect === 'number') firstTryCorrect += s.firstTryCorrect;
    }
    out[mode] = {
      sessions: m.sessions,
      aborted: m.aborted,
      totalMs: m.totalMs,
      activeMs: m.activeMs,
      recentSessions: m.recent.length,
      recentAttempted: attempted,
      recentFirstTryCorrect: firstTryCorrect,
      firstTryRate: attempted > 0 ? firstTryCorrect / attempted : null,
      weak: [...m.weak.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([q, n]) => ({ q, n })),
    };
  }
  return out;
}

/** ミリ秒を「◯分」「◯時間◯分」の日本語表記にする */
export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '1分みまん';
  if (totalMin < 60) return `${totalMin}分`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}
