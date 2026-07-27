/*
 * study.v1 学習ログの「読み出し側」ユーティリティ（このアプリ専用）
 *
 * 保存側（studyLog.js）は全アプリ共通・同一内容とする決まりのため、
 * 集計・表示のためのコードはこちらに分離している。
 * 読み出し専用であり、`study.records.v1` を書き換えたり削除したりはしない。
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
 * 正答率は仕様どおり firstTryCorrect（初回正答）を主指標とする。
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
    m.sessions++;
    if (r.status === 'aborted') m.aborted++;
    if (typeof r.elapsedMs === 'number') m.totalMs += r.elapsedMs;
    if (typeof r.activeMs === 'number') m.activeMs += r.activeMs;

    // records は新しい順なので、先頭 recentCount 件が「さいきん」
    if (m.recent.length < recentCount) m.recent.push(r);

    if (Array.isArray(r.items)) {
      for (const it of r.items) {
        if (!it || it.firstTry !== false || !it.q) continue;
        m.weak.set(it.q, (m.weak.get(it.q) || 0) + 1);
      }
    }
  }

  const out = {};
  for (const [mode, m] of Object.entries(byMode)) {
    let count = 0;
    let firstTryCorrect = 0;
    for (const r of m.recent) {
      const s = r.summary || {};
      if (typeof s.count === 'number') count += s.count;
      if (typeof s.firstTryCorrect === 'number') firstTryCorrect += s.firstTryCorrect;
    }
    out[mode] = {
      sessions: m.sessions,
      aborted: m.aborted,
      totalMs: m.totalMs,
      activeMs: m.activeMs,
      recentSessions: m.recent.length,
      recentCount: count,
      recentFirstTryCorrect: firstTryCorrect,
      firstTryRate: count > 0 ? firstTryCorrect / count : null,
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
