import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { Calculator, Settings, Play, RefreshCw, Trophy, History, X, CheckCircle, Volume2, VolumeX, Keyboard, BarChart2, Clock, ArrowRight, PenTool, Eraser, MoveHorizontal, Target, LogOut, Flame, Download, Sparkles, Maximize2, Minimize2 } from 'lucide-react';
import {
  APP_ID, MODE_ID, answerOf, inputMethodOf, allCellKeys,
  createStudySession, recordAttempt, markCellTiming, finalizeStudySession,
} from './studySession';
import { loadStudyRecords, summarizeByMode, formatDuration } from './studyStats';
import { isStandalone } from './pwa';

// ==========================================
// 🎵 効果音生成エンジン (Web Audio API)
// ==========================================
let audioCtx = null;

// TensorFlow.js 本体。手書き入力を使うときだけ import() で読み込むため、
// 読み込みが済むまでは null。CDN ではなく自分側に置いている（§6）
let tfjs = null;

const initAudioContext = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
};

const playSound = (type) => {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  const now = audioCtx.currentTime;

  if (type === 'correct') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1108.73, now + 0.1);
    gainNode.gain.setValueAtTime(0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  } else if (type === 'wrong') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, now);
    gainNode.gain.setValueAtTime(0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc.start(now);
    osc.stop(now + 0.2);
  } else if (type === 'finish') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.setValueAtTime(659.25, now + 0.1);
    osc.frequency.setValueAtTime(783.99, now + 0.2);
    osc.frequency.setValueAtTime(1046.50, now + 0.3);
    gainNode.gain.setValueAtTime(0.4, now);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.8);
    osc.start(now);
    osc.stop(now + 0.8);
  }
};

// 偏りのないシャッフル (Fisher–Yates)
const shuffle = (array) => {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

// ==========================================
// ⚡ カスタムフック: 高精度＆軽量タイマー
// ==========================================
const useHighResTimer = () => {
  const displayRef = useRef(null);
  const startTimeRef = useRef(0);
  const reqRef = useRef(null);
  const [finalTime, setFinalTime] = useState(0);

  const start = useCallback(() => {
    startTimeRef.current = performance.now();
    setFinalTime(0);
    const update = () => {
      const diff = (performance.now() - startTimeRef.current) / 1000;
      if (displayRef.current) {
        displayRef.current.textContent = diff.toFixed(1);
      }
      reqRef.current = requestAnimationFrame(update);
    };
    reqRef.current = requestAnimationFrame(update);
  }, []);

  // 経過時間を止めずに読む（中断時に「タブを離れた時刻」を控えるのに使う）
  const peek = useCallback(() => (performance.now() - startTimeRef.current) / 1000, []);

  // atSeconds を渡すと、その時点で止めたものとして締める。
  // タブを離れたまま戻らなかった中断で、待っていた時間を含めないために使う
  const stop = useCallback((atSeconds) => {
    if (reqRef.current) cancelAnimationFrame(reqRef.current);
    const final = atSeconds !== undefined
      ? atSeconds
      : (performance.now() - startTimeRef.current) / 1000;
    setFinalTime(final);
    if (displayRef.current) {
      displayRef.current.textContent = final.toFixed(1);
    }
    return final;
  }, []);

  const reset = useCallback(() => {
    if (reqRef.current) cancelAnimationFrame(reqRef.current);
    setFinalTime(0);
    if (displayRef.current) {
      displayRef.current.textContent = "0.0";
    }
  }, []);

  useEffect(() => {
    return () => {
      if (reqRef.current) cancelAnimationFrame(reqRef.current);
    };
  }, []);

  return useMemo(
    () => ({ displayRef, start, stop, peek, reset, finalTime }),
    [start, stop, peek, reset, finalTime]
  );
};

// ==========================================
// ⏱ カスタムフック: 実際に操作していた時間 (activeMs) の計測
// ==========================================
// elapsedMs（開始〜終了の実時間）との差が大きい児童は集中が途切れている
// 可能性があり、それ自体が指導情報になる（study.v1 §2.8）
const useActiveTimeTracker = () => {
  const stateRef = useRef({ activeMs: 0, mark: 0, idle: false, running: false });
  const cleanupRef = useRef(null);

  const tick = useCallback(() => {
    const s = stateRef.current;
    if (!s.running) return;
    const now = Date.now();
    if (!s.idle && !document.hidden) s.activeMs += now - s.mark;
    s.mark = now;
  }, []);

  const teardown = useCallback(() => {
    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = null;
  }, []);

  const start = useCallback(() => {
    teardown();
    stateRef.current = { activeMs: 0, mark: Date.now(), idle: false, running: true };

    const wake = () => { tick(); stateRef.current.idle = false; };
    const events = ['click', 'keydown', 'touchstart', 'pointerdown'];
    const tickTimer = setInterval(tick, 1000);
    // 60秒間まったく操作がなければ計測を止める
    const idleTimer = setInterval(() => { tick(); stateRef.current.idle = true; }, 60000);
    document.addEventListener('visibilitychange', tick);
    events.forEach(ev => document.addEventListener(ev, wake));

    cleanupRef.current = () => {
      clearInterval(tickTimer);
      clearInterval(idleTimer);
      document.removeEventListener('visibilitychange', tick);
      events.forEach(ev => document.removeEventListener(ev, wake));
    };
  }, [tick, teardown]);

  const stop = useCallback(() => {
    tick();
    stateRef.current.running = false;
    teardown();
    return Math.round(stateRef.current.activeMs);
  }, [tick, teardown]);

  useEffect(() => teardown, [teardown]);

  return useMemo(() => ({ start, stop }), [start, stop]);
};

// ==========================================
// 🪟 カスタムフック: モーダルのフォーカス閉じ込め
// ==========================================
// 開いている間、Tab がモーダルの外へ出ないようにし、閉じたら元の場所へ返す。
// キーボードだけで操作している児童・先生が、見えていない背景のボタンに
// フォーカスを落として迷子になるのを防ぐ（Part I §4）。
// Esc で閉じる処理は、既にある一括のハンドラに任せてある。
const useModalFocus = (ref, isOpen) => {
  useEffect(() => {
    if (!isOpen) return;
    const box = ref.current;
    if (!box) return;
    const prevFocused = document.activeElement;

    const focusables = () => Array.from(box.querySelectorAll(
      'a[href],button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null);

    const first = focusables()[0];
    if (first) first.focus();
    else box.focus();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const head = list[0];
      const tail = list[list.length - 1];
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    box.addEventListener('keydown', onKeyDown);
    return () => {
      box.removeEventListener('keydown', onKeyDown);
      if (prevFocused && typeof prevFocused.focus === 'function') prevFocused.focus();
    };
  }, [ref, isOpen]);
};

// ==========================================
// 🧩 コンポーネント: 最適化された個別のセル
// ==========================================
const Cell = memo(({
  r, c, val, ans, isActive, disabled, autoScore, suppressOsKeyboard, ariaLabel,
  onFocus, onChange, onKeyDown, inputRefs
}) => {
  // 正誤の色を出してよいのは「採点が済んでいる」ときだけ。
  // ⚠️ すぐ判定（自動採点）をオフにしたのに色がその場で付くと、設定の意味が無くなる。
  //    「あとでまとめて丸つけする」ために切っているのに、入力した瞬間に赤と緑が出て
  //    しまい、紙のテストのように最後まで自分で解ききる練習ができない。
  //    すぐ判定オフのときは、採点が終わった後（プレイ中でない＝disabled）に見せる。
  const marked = autoScore || disabled;
  let cellClass = "";
  if (marked && val !== '') {
    if (parseInt(val, 10) === ans) cellClass = "cell-correct border-green-400";
    // すぐ判定オンのときは打っている途中で赤くしない（12 の «1» で赤が出る）。
    // 採点後にまとめて見せる場合は、桁が足りない答えも「まちがい」として示す
    else if (!autoScore || val.length >= String(ans).length) cellClass = "cell-wrong border-red-400";
  }

  // 不正解で値がクリアされた時だけ赤くフラッシュさせる
  // (remount させないので入力フォーカスは維持される)
  const prevValRef = useRef(val);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const prevVal = prevValRef.current;
    prevValRef.current = val;
    if (prevVal !== '' && val === '' && !disabled) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 400);
      return () => clearTimeout(t);
    }
  }, [val, disabled]);

  return (
    <td className={`border-2 border-slate-300 p-0 relative ${isActive ? 'ring-2 ring-slate-500 z-10' : ''}`}>
      <input
        ref={el => { inputRefs.current[`${r}_${c}`] = el; }}
        type={suppressOsKeyboard ? 'text' : 'tel'}
        inputMode={suppressOsKeyboard ? 'none' : 'numeric'}
        // 手書き・テンキーを使う間は端末のソフトウェアキーボード（Gboard など）を出さない。
        // inputMode="none" は iPadOS が未対応で Android でも無視されることがあるため、
        // どの端末でも確実に抑止できる readOnly を併用する。
        // readOnly だと入力欄自身は文字を受け付けないが、値は手書き認識・テンキー・
        // 物理キーボード（handleCellKeyDown）から JS で書き込むので入力は妨げられない
        readOnly={suppressOsKeyboard}
        autoComplete="off"
        enterKeyHint="next"
        aria-label={ariaLabel}
        value={val}
        disabled={disabled || (autoScore && parseInt(val, 10) === ans)}
        // readOnly なマスに focus が飛ばない端末でも「いま解いているマス」が
        // 切り替わるように、タップ時点でも対象セルを確定させる
        onPointerDown={() => { if (!isActive) onFocus(r, c); }}
        onFocus={() => onFocus(r, c)}
        onChange={(e) => onChange(r, c, e.target.value)}
        onKeyDown={(e) => onKeyDown(e, r, c)}
        className={`text-center font-bold outline-none bg-transparent transition-colors ${cellClass} ${flash ? 'cell-error-flash' : ''}`}
        style={{ width: '100%', height: '100%' }}
      />
    </td>
  );
});

// ==========================================
// 🌟 メインアプリケーション
// ==========================================
export default function App() {
  const [gameState, setGameState] = useState('idle');
  const [mode, setMode] = useState('たし算');
  const [count, setCount] = useState(10);
  const [resultScore, setResultScore] = useState(null);

  const timer = useHighResTimer();
  const activeTimer = useActiveTimeTracker();

  const [tableData, setTableData] = useState({ rows: [], cols: [] });
  const [inputs, setInputs] = useState({});
  const [activeCell, setActiveCell] = useState(null);

  // localStorage から同期的に初期化する（初回レンダー時から保存済み設定を反映し、
  // デフォルト値で一瞬描画される・TFが不要なのに読み込まれる、を防ぐ）
  const [settings, setSettings] = useState(() => {
    const defaults = {
      sound: true,
      numpad: false,
      handwriting: true,
      autoScore: true,
      inputPosition: 'right'
    };
    try {
      const saved = JSON.parse(localStorage.getItem('giga_calc_settings_v4') || 'null');
      return saved ? { ...defaults, ...saved } : defaults;
    } catch (e) {
      console.error("設定の読み込みに失敗しました:", e);
      return defaults;
    }
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);

  const settingsBoxRef = useRef(null);
  const statsBoxRef = useRef(null);
  const quitBoxRef = useRef(null);
  useModalFocus(settingsBoxRef, showSettings);
  useModalFocus(statsBoxRef, showStats);
  useModalFocus(quitBoxRef, showQuitConfirm);

  // ホーム画面・デスクトップへの追加を案内できるか。
  // ⚠️ 案内できるときだけボタンを出す。出せないボタンを置いておくと
  //    「押しても何も起きない」と言われる（§3-2）。
  //    合図（beforeinstallprompt）は install-hook.js が <head> の先頭で
  //    受け取り済み。React の読み込みを待つと取りこぼす。
  const [canInstall, setCanInstall] = useState(
    () => !!window.__pwaInstallPrompt && !isStandalone()
  );
  useEffect(() => {
    const onAvailable = () => setCanInstall(!isStandalone());
    const onInstalled = () => setCanInstall(false);
    window.addEventListener('pwa-install-available', onAvailable);
    window.addEventListener('pwa-installed', onInstalled);
    return () => {
      window.removeEventListener('pwa-install-available', onAvailable);
      window.removeEventListener('pwa-installed', onInstalled);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    const prompt = window.__pwaInstallPrompt;
    if (!prompt) return;
    // 合図は一度しか使えない。押した時点で消しておかないと二度目で例外になる
    window.__pwaInstallPrompt = null;
    setCanInstall(false);
    prompt.prompt();
    await prompt.userChoice;
  }, []);

  // 新しい版が待機していることの案内。
  // ⚠️ 押されるまで切り替えない。計算の途中で入れ替わると、
  //    打ちかけの答えも計測中のタイムも消える（§3-3）。
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const onReady = () => setUpdateReady(true);
    window.addEventListener('pwa-update-ready', onReady);
    return () => window.removeEventListener('pwa-update-ready', onReady);
  }, []);

  const [tfModel, setTfModel] = useState(null);
  const [aiStatus, setAiStatus] = useState(<span>AI<ruby>準備中<rp>(</rp><rt>じゅんびちゅう</rt><rp>)</rp></ruby>...</span>);
  const canvasRefs = [useRef(null), useRef(null)];
  const isDrawingRef = useRef([false, false]);
  const isDirtyRef = useRef([false, false]);
  const lastPosRef = useRef([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  const ocrTimerRef = useRef(null);
  const activeCellRef = useRef(null);
  // 同一イベント内で checkCompletion が複数回呼ばれても
  // stopGame（記録保存・効果音）が二重実行されないようにするガード
  const runningRef = useRef(false);
  // 最新の入力値をイベントハンドラから同期的に参照するためのミラー
  const inputsRef = useRef({});
  // 学習ログ (study.v1) のセッション状態。startGame で作り、終了時に消費する
  const sessionRef = useRef(null);

  const [records, setRecords] = useState(() => {
    const defaults = {
      'たし算': { best: {}, history: [] },
      '引き算': { best: {}, history: [] },
      'かけ算': { best: {}, history: [] },
    };
    try {
      const parsed = JSON.parse(localStorage.getItem('giga_calc_records_v4') || 'null');
      if (parsed) {
        for (const key of Object.keys(defaults)) {
          if (parsed[key]) {
            defaults[key] = {
              best: parsed[key].best || {},
              history: Array.isArray(parsed[key].history) ? parsed[key].history : []
            };
          }
        }
      }
    } catch (e) {
      console.error("記録の読み込みに失敗しました:", e);
    }
    return defaults;
  });

  const inputRefs = useRef({});

  // ベストタイム(ext.bestMs)を、レンダーに依存せず保存処理から参照するためのミラー
  const recordsRef = useRef(records);
  useEffect(() => { recordsRef.current = records; }, [records]);

  // pagehide / pageshow は張り替えずに最新の状態を読む必要があるためミラーを持つ
  const tableDataRef = useRef(tableData);
  const modeRef = useRef(mode);
  const countRef = useRef(count);
  const settingsRef = useRef(settings);
  useEffect(() => {
    tableDataRef.current = tableData;
    modeRef.current = mode;
    countRef.current = count;
    settingsRef.current = settings;
  });

  useEffect(() => {
    const handleUserInteraction = () => {
      initAudioContext();
      window.removeEventListener('touchstart', handleUserInteraction);
      window.removeEventListener('mousedown', handleUserInteraction);
      window.removeEventListener('keydown', handleUserInteraction);
    };
    window.addEventListener('touchstart', handleUserInteraction);
    window.addEventListener('mousedown', handleUserInteraction);
    window.addEventListener('keydown', handleUserInteraction);

    generateTable(mode, count);

    return () => {
      window.removeEventListener('touchstart', handleUserInteraction);
      window.removeEventListener('mousedown', handleUserInteraction);
      window.removeEventListener('keydown', handleUserInteraction);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('giga_calc_settings_v4', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('giga_calc_records_v4', JSON.stringify(records));
  }, [records]);

  // ⚠️ localStorage.clear() は使わないこと。`study.records.v1` は他アプリと
  // 共有している学習ログであり、このアプリのリセット対象に含めてはならない。

  // 手書き入力が有効な時だけ TensorFlow.js (約1MB) を読み込む。
  // 設定でオフにしているユーザーには余計な通信をさせない
  const tfLoadStartedRef = useRef(false);
  useEffect(() => {
    if (settings.handwriting && !tfLoadStartedRef.current) {
      tfLoadStartedRef.current = true;
      initTensorFlow();
    }
  }, [settings.handwriting]);

  // Esc キーでモーダルを閉じられるようにする
  useEffect(() => {
    if (!showSettings && !showStats && !showQuitConfirm) return;
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        setShowSettings(false);
        setShowStats(false);
        setShowQuitConfirm(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [showSettings, showStats, showQuitConfirm]);

  // 🖥️ 提示モード（§2-11）
  //
  // 100マス計算は「先生の合図で一斉に始める」使い方が多く、電子黒板に映して
  // 「今日はここ」「あと何問」を全員で見る場面がある。4K を 65〜75インチで
  // 遠くから見るため、通常の大きさでは教室のうしろの席から数字が読めない。
  // 押すと文字とマスを大きくし、あわせて全画面表示にする。
  //
  // ⚠️ 児童名・出席番号を扱わないアプリなので、提示モードで伏せる情報は無い。
  const [presenting, setPresenting] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('presentation', presenting);
    return () => document.body.classList.remove('presentation');
  }, [presenting]);

  // ⚠️ 全画面は Esc やブラウザの UI からも解除される。それを拾わないと
  //    「文字は大きいまま全画面ではない」というちぐはぐな状態が残り、
  //    先生が同じボタンをもう一度押しても戻らなくなる。
  useEffect(() => {
    const sync = () => { if (!document.fullscreenElement) setPresenting(false); };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const togglePresentation = useCallback(async () => {
    if (presenting) {
      setPresenting(false);
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => { });
      }
      return;
    }
    setPresenting(true);
    // iPad の Safari は要素の全画面表示に対応していない。
    // 全画面に入れなくても「大きくする」ところまでは効かせる
    await document.documentElement.requestFullscreen?.().catch(() => { });
  }, [presenting]);

  // 画面の「幅」と「残りの高さ」の両方からマスの大きさを自動計算し、
  // 横画面や 100 問モードでも全マスがスクロールなしで 1 画面に収まるようにする
  const gridWrapRef = useRef(null);
  const [cellSize, setCellSize] = useState(48);
  useEffect(() => {
    const el = gridWrapRef.current;
    if (!el) return;
    const compute = () => {
      // 幅から: 11 列（見出し + 10 列）+ border-collapse された 2px 枠線 × 12
      const byWidth = Math.floor((el.clientWidth - 26) / 11);
      // 高さから: 表の上端〜画面下端までに (行数 + 見出し行) がすべて収まるサイズ
      const rowsCount = tableData.rows.length + 1;
      const availH = window.innerHeight - el.getBoundingClientRect().top - 16;
      const byHeight = Math.floor((availH - (rowsCount + 1) * 2) / rowsCount);
      // 上限は CSS の --cell-max を正本にする。提示モードで body に .presentation が
      // 付くと CSS 側だけが変わり、ここが古い上限のままだとマスが大きくならない
      const cssMax = parseInt(
        getComputedStyle(document.body).getPropertyValue('--cell-max'), 10
      );
      const size = Math.min(Number.isFinite(cssMax) ? cssMax : 56, byWidth, byHeight);
      // 22px を下回るほど画面が小さい時だけスクロールにフォールバック
      setCellSize(Math.max(22, size));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener('resize', compute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', compute);
    };
    // gameState も依存に含める: 結果バナーの表示で表の上端位置が変わるため。
    // presenting も含める: .presentation が付くと --cell-max が変わる
  }, [tableData, gameState, presenting]);

  // TensorFlow.js 本体と、それを使う推論モデルを読み込む。
  //
  // ⚠️ 以前はここで cdn.jsdelivr.net から <script> を差し込んでいた。
  //    学校のネットワークは jsDelivr を塞いでいることがあり、実測すると
  //    ERR_TUNNEL_CONNECTION_FAILED で window.tf が未定義のまま、
  //    「AIの準備に失敗しました」と出て手書き入力が丸ごと使えなくなっていた。
  //    手書きは既定でオンなので、多くの児童が影響を受ける。
  //    しかも原因がアプリの外（学校の設定）にあるため、先生が調べても分からない。
  //    → 自分側に置き、通信の可否に関係なく動くようにした（Part I §1・§6）。
  //
  //    import() にしてあるのは、手書きをオフにしている端末に約1MBを
  //    ダウンロードさせないため。Vite が別チャンクに切り出す。
  const initTensorFlow = async () => {
    setAiStatus(<span>AIモデルを<ruby>読<rp>(</rp><rt>よ</rt><rp>)</rp></ruby>み<ruby>込<rp>(</rp><rt>こ</rt><rp>)</rp></ruby>み<ruby>中<rp>(</rp><rt>ちゅう</rt><rp>)</rp></ruby>...</span>);
    try {
      if (!tfjs) {
        // 手書き認識モデルは GraphModel なので、必要なのは core と converter、
        // それに実行する土台（WebGL・使えない端末向けの CPU）だけ。
        // `@tensorflow/tfjs` を丸ごと読むと tfjs-layers / tfjs-data まで付いてきて
        // 転送量が倍近くなる。校内 Wi-Fi で40人が同時に開く前提では効く（§8）
        const [core] = await Promise.all([
          import('@tensorflow/tfjs-core'),
          import('@tensorflow/tfjs-converter'),
          import('@tensorflow/tfjs-backend-webgl'),
          import('@tensorflow/tfjs-backend-cpu'),
        ]);
        const converter = await import('@tensorflow/tfjs-converter');
        tfjs = { ...core, loadGraphModel: converter.loadGraphModel };
        await core.ready();
      }
      const model = await tfjs.loadGraphModel(`${import.meta.env.BASE_URL}model.json`);
      setTfModel(model);
      setAiStatus(<span><ruby>手書<rp>(</rp><rt>てが</rt><rp>)</rp></ruby>き<ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby>が<ruby>使<rp>(</rp><rt>つか</rt><rp>)</rp></ruby>えます</span>);
    } catch (e) {
      console.error("TF初期化エラー:", e);
      // 再試行できるように、失敗したら次回の設定オンでもう一度読みにいけるようにする
      tfLoadStartedRef.current = false;
      setAiStatus(<span>AIの<ruby>準備<rp>(</rp><rt>じゅんび</rt><rp>)</rp></ruby>に<ruby>失敗<rp>(</rp><rt>しっぱい</rt><rp>)</rp></ruby>しました</span>);
    }
  };

  const clearAllCanvas = useCallback(() => {
    for (let i = 0; i < 2; i++) {
      const canvas = canvasRefs[i].current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        isDirtyRef.current[i] = false;
      }
    }
    if (ocrTimerRef.current) clearTimeout(ocrTimerRef.current);
  }, []);

  // 手書き欄の解像度を、実際に表示されている大きさに合わせる（§2-5）。
  //
  // 以前は width/height を 320 固定にしていたため、CSS 側の枠が横長になる
  // 端末（Chromebook の分割画面・横向きの iPad）では正方形の絵が引き伸ばされ、
  // 縦横比の違う数字を 28×28 に縮めて推論することになっていた。
  // 線もぼやける。
  //
  // dpr を 2 で頭打ちにするのは、3倍端末で 9倍の面積を描くとメモリ4GBの
  // Chromebook がタブごと落ちるため。2 あれば肉眼では十分きれい。
  const fitCanvases = useCallback(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (let i = 0; i < 2; i++) {
      const canvas = canvasRefs[i].current;
      if (!canvas) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width === w && canvas.height === h) continue;
      // 大きさを変えると中身は消えるので、書きかけを消したことを状態にも反映する
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      isDirtyRef.current[i] = false;
    }
  }, []);

  // 画面回転・分割画面・電子黒板への出力切替に追従させる
  useEffect(() => {
    if (!settings.handwriting) return;
    fitCanvases();
    const ro = new ResizeObserver(fitCanvases);
    canvasRefs.forEach((ref) => { if (ref.current) ro.observe(ref.current); });
    return () => ro.disconnect();
  }, [settings.handwriting, fitCanvases]);

  // ------------------------------------------
  // 📚 学習ログ (study.v1) の記録
  // ------------------------------------------
  // 組み立てとスキーマの詳細は studySession.js を参照。
  // ここではセッションの開始・終了と、アプリ側の値の受け渡しだけを行う。
  // status: 'completed' | 'aborted'
  // exactTimeSec は画面タイマーの経過秒。復帰後のレコードは
  // セッション開始時点からの分だけを elapsedMs とする
  const saveSession = useCallback((status, exactTimeSec) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    finalizeStudySession(session, {
      status,
      elapsedMs: Math.max(0, exactTimeSec - session.startOffsetSec) * 1000,
      activeMs: activeTimer.stop(),
      inputs: inputsRef.current,
      prevBestSec: recordsRef.current?.[session.mode]?.best?.[session.cells],
    });
  }, [activeTimer]);

  const generateTable = useCallback((currentMode, currentCount) => {
    const rowsCount = currentCount / 10;

    const newCols = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const newRows = [];

    for (let i = 0; i < rowsCount; i++) {
      if (currentMode === '引き算') {
        newRows.push(Math.floor(Math.random() * 10) + 10);
      } else {
        newRows.push(Math.floor(Math.random() * 10));
      }
    }

    setTableData({ rows: newRows, cols: newCols });
    setInputs({});
    inputsRef.current = {};
    sessionRef.current = null;
    setGameState('idle');
    setResultScore(null);
    timer.reset();
    clearAllCanvas();
  }, [timer.reset, clearAllCanvas]);

  const handleModeChange = (e) => {
    setMode(e.target.value);
    generateTable(e.target.value, count);
  };

  const handleCountChange = (e) => {
    const newCount = parseInt(e.target.value, 10);
    setCount(newCount);
    generateTable(mode, newCount);
  };

  const startGame = () => {
    initAudioContext();
    setGameState('playing');
    setInputs({});
    inputsRef.current = {};
    setResultScore(null);
    setActiveCell({ r: 0, c: 0 });
    activeCellRef.current = { r: 0, c: 0 };
    runningRef.current = true;
    clearAllCanvas();

    // 学習ログ用のセッションを開始する
    sessionRef.current = createStudySession({
      mode,
      cells: count,
      rows: tableData.rows,
      cols: tableData.cols,
      autoScore: settings.autoScore,
      input: inputMethodOf(settings),
    });
    markCellTiming(sessionRef.current, '0_0');
    activeTimer.start();

    setTimeout(() => {
      if (inputRefs.current['0_0']) inputRefs.current['0_0'].focus();
    }, 100);

    timer.start();
  };

  const stopGame = useCallback((finalScore) => {
    if (!runningRef.current) return;
    runningRef.current = false;
    const exactTime = timer.stop();
    setGameState('result');
    setResultScore(finalScore);
    if (settings.sound) playSound('finish');
    saveSession('completed', exactTime);

    if (finalScore === count) {
      const today = new Date().toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      // date は年を含まない表示用文字列。並べ替え・集計に使えるよう ISO 8601 も持たせる
      const newRecord = { date: today, at: new Date().toISOString(), time: exactTime, count: count };

      setRecords(prev => {
        const modeData = prev[mode];
        const newHistory = [newRecord, ...modeData.history].slice(0, 20);
        let newBest = modeData.best[count];
        if (!newBest || exactTime < newBest) {
          newBest = exactTime;
        }
        return {
          ...prev,
          [mode]: { ...modeData, best: { ...modeData.best, [count]: newBest }, history: newHistory }
        };
      });
    }
  }, [count, mode, settings.sound, timer.stop, saveSession]);

  // 途中でやめた記録も残す（study.v1 §5.4）。
  // 「難しすぎる」「量が多すぎる」という重要なサインなので、捨ててはならない。
  // atSeconds を渡すと、その時点で締める（タブ離脱による中断で使う）
  const abortGame = useCallback((atSeconds) => {
    setShowQuitConfirm(false);
    if (!runningRef.current) return;
    runningRef.current = false;
    const exactTime = timer.stop(atSeconds);

    let correctCount = 0;
    for (let r = 0; r < tableData.rows.length; r++) {
      for (let c = 0; c < tableData.cols.length; c++) {
        const val = inputsRef.current[`${r}_${c}`];
        const ans = answerOf(mode, tableData.rows[r], tableData.cols[c]);
        if (val !== undefined && val !== '' && parseInt(val, 10) === ans) correctCount++;
      }
    }

    setGameState('result');
    setResultScore(correctCount);
    saveSession('aborted', exactTime);
  }, [mode, tableData, timer.stop, saveSession]);

  // タブを離れたまま5分戻ってこない場合も「中断」として記録する（§5.4）。
  // 猶予を短くすると、教師の説明を聞くための数分の離席まで中断になってしまうため、
  // 5分より短くしないこと。
  // 記録は「タブを離れた時刻」で締める。待っていた5分を学習時間に含めると、
  // 全児童の学習時間が水増しされる。
  const abortRef = useRef(abortGame);
  useEffect(() => { abortRef.current = abortGame; }, [abortGame]);
  useEffect(() => {
    if (gameState !== 'playing') return;
    let awayTimer = null;
    const onVisibility = () => {
      if (document.hidden) {
        const leftAtSec = timer.peek();
        awayTimer = setTimeout(() => {
          if (document.hidden && runningRef.current) abortRef.current(leftAtSec);
        }, 5 * 60 * 1000);
      } else if (awayTimer) {
        clearTimeout(awayTimer);
        awayTimer = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (awayTimer) clearTimeout(awayTimer);
    };
  }, [gameState, timer.peek]);

  // Chromebook はメモリ不足やスリープでタブごと破棄されることがある。
  // 5分タイマー方式だけでは、タブが消えた時点でタイマーも消え、
  // 記録中のレコードが丸ごと失われる。pagehide で必ず確定させる（§5.4）。
  // beforeunload はモバイルや bfcache 経路で発火しないことがあるため使わない。
  const pendingResumeRef = useRef(false);
  useEffect(() => {
    const onPageHide = () => {
      if (!runningRef.current || !sessionRef.current) return;
      // 離脱時点で締める。1問も解答していなければ保存されない（§5.4）
      saveSession('aborted', timer.peek());
      // bfcache から戻って学習が続く場合に備えて、残り分での再開を控えておく
      pendingResumeRef.current = true;
    };
    const onPageShow = (e) => {
      const resume = pendingResumeRef.current;
      pendingResumeRef.current = false;
      // 中断済みレコードには追記しない。復帰後は残りのマスで新しいレコードを開始する
      if (!e.persisted || !resume || !runningRef.current || sessionRef.current) return;

      const { rows, cols } = tableDataRef.current;
      const remaining = allCellKeys(rows, cols).filter((key) => {
        const [r, c] = key.split('_').map(Number);
        const val = inputsRef.current[key];
        return !(val !== undefined && val !== '' && parseInt(val, 10) === answerOf(modeRef.current, rows[r], cols[c]));
      });
      if (remaining.length === 0) return;

      sessionRef.current = createStudySession({
        mode: modeRef.current,
        cells: countRef.current,
        rows,
        cols,
        autoScore: settingsRef.current.autoScore,
        input: inputMethodOf(settingsRef.current),
        scope: remaining,
        startOffsetSec: timer.peek(),
      });
      markCellTiming(sessionRef.current, activeCellRef.current
        ? `${activeCellRef.current.r}_${activeCellRef.current.c}` : remaining[0]);
      activeTimer.start();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [saveSession, timer.peek, activeTimer]);

  const getCorrectAnswer = useCallback((r, c) => {
    const rowVal = tableData.rows[r];
    const colVal = tableData.cols[c];
    if (mode === 'たし算') return rowVal + colVal;
    if (mode === '引き算') return rowVal - colVal;
    if (mode === 'かけ算') return rowVal * colVal;
    return 0;
  }, [mode, tableData]);

  // force: 入力途中でも「全マス回答済みなら採点してよい」とみなすか
  // （Enter や「次へ」で明示的に確定した時に true）
  const checkCompletion = useCallback((newInputs, force = false) => {
    let answeredCount = 0;
    let correctCount = 0;
    for (let r = 0; r < tableData.rows.length; r++) {
      for (let c = 0; c < tableData.cols.length; c++) {
        const ans = getCorrectAnswer(r, c);
        const val = newInputs[`${r}_${c}`];
        if (val !== undefined && val !== '') {
          answeredCount++;
          if (parseInt(val, 10) === ans) correctCount++;
        }
      }
    }

    if (settings.autoScore) {
      // すぐ判定モードでは全マス正解で終了。
      // 2桁の答えの1桁目を入力しただけで「全マス回答済み」と
      // 誤判定して途中終了しないように、正解数だけで判定する
      if (correctCount === count) {
        stopGame(count);
      }
    } else if (answeredCount === count && force) {
      stopGame(correctCount);
    }
  }, [count, getCorrectAnswer, stopGame, tableData, settings.autoScore]);

  const moveToNextCell = useCallback((r, c) => {
    // 確定操作（Enter / 次へ / →）の時点で全マス回答済みなら採点する
    checkCompletion(inputsRef.current, true);
    if (!runningRef.current) return; // 採点でゲームが終了した

    // すぐ判定モードで既に正解済みのセルはスキップする
    let nextR = r;
    let nextC = c;
    while (true) {
      nextC++;
      if (nextC >= 10) { nextC = 0; nextR++; }
      if (nextR >= tableData.rows.length) return;
      const val = inputsRef.current[`${nextR}_${nextC}`];
      const alreadyCorrect = settings.autoScore && val !== undefined && val !== '' && parseInt(val, 10) === getCorrectAnswer(nextR, nextC);
      if (!alreadyCorrect) break;
    }
    const nextCell = { r: nextR, c: nextC };
    setActiveCell(nextCell);
    activeCellRef.current = nextCell;
    if (inputRefs.current[`${nextR}_${nextC}`]) {
      inputRefs.current[`${nextR}_${nextC}`].focus();
    }
  }, [tableData, settings.autoScore, getCorrectAnswer, checkCompletion]);

  const handleInputChange = useCallback((r, c, value) => {
    if (gameState !== 'playing') return;

    const val = value.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/[^0-9]/g, '');

    const ans = getCorrectAnswer(r, c);
    const ansStr = String(ans);
    let storedVal = val;

    // 答えの桁数まで入力されたら「1回の解答」として学習ログに記録する。
    // 採点で終了する可能性があるため、必ず終了処理より先に記録する
    if (val.length > 0 && val.length >= ansStr.length) {
      recordAttempt(sessionRef.current, r, c, val, parseInt(val, 10) === ans);
    }

    if (settings.autoScore && val.length > 0) {
      if (parseInt(val, 10) === ans) {
        if (settings.sound) playSound('correct');
        moveToNextCell(r, c);
        clearAllCanvas();
      } else if (val.length >= ansStr.length) {
        if (settings.sound) playSound('wrong');
        storedVal = '';
        clearAllCanvas();
      }
    }

    const newInputs = { ...inputsRef.current, [`${r}_${c}`]: storedVal };
    inputsRef.current = newInputs;
    setInputs(newInputs);
    // 答えの桁数まで入力し終えたマスだけ「回答済み」として採点判定する
    checkCompletion(newInputs, val.length >= ansStr.length);
  }, [gameState, getCorrectAnswer, settings, moveToNextCell, checkCompletion, clearAllCanvas]);

  const handleCellFocus = useCallback((r, c) => {
    const cell = { r, c };
    setActiveCell(cell);
    activeCellRef.current = cell;
    markCellTiming(sessionRef.current, `${r}_${c}`);
    clearAllCanvas();
  }, [clearAllCanvas]);

  const handleCellKeyDown = useCallback((e, r, c) => {
    // ソフトウェアキーボード抑止のためマスを readOnly にしている間は、
    // input の既定の文字入力が働かない。物理キーボードでも今までどおり
    // 数字が打てるように、数字キーとバックスペースを自前で反映する
    if (settings.numpad || settings.handwriting) {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        handleInputChange(r, c, (inputsRef.current[`${r}_${c}`] || '') + e.key);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        handleInputChange(r, c, (inputsRef.current[`${r}_${c}`] || '').slice(0, -1));
        return;
      }
    }

    if (e.key === 'Enter') {
      moveToNextCell(r, c);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault(); moveToNextCell(r, c);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      let prevC = c - 1; let prevR = r;
      if (prevC < 0) { prevC = 9; prevR--; }
      if (prevR >= 0) {
        const prevCell = { r: prevR, c: prevC };
        setActiveCell(prevCell);
        activeCellRef.current = prevCell;
        inputRefs.current[`${prevR}_${prevC}`]?.focus();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (r + 1 < tableData.rows.length) {
        const downCell = { r: r + 1, c };
        setActiveCell(downCell);
        activeCellRef.current = downCell;
        inputRefs.current[`${r + 1}_${c}`]?.focus();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (r - 1 >= 0) {
        const upCell = { r: r - 1, c };
        setActiveCell(upCell);
        activeCellRef.current = upCell;
        inputRefs.current[`${r - 1}_${c}`]?.focus();
      }
    }
  }, [moveToNextCell, tableData, settings.numpad, settings.handwriting, handleInputChange]);

  const handleNumpadInput = useCallback((num) => {
    if (gameState !== 'playing' || !activeCellRef.current) return;
    const { r, c } = activeCellRef.current;
    const currentVal = inputsRef.current[`${r}_${c}`] || '';
    const newVal = num === 'back' ? currentVal.slice(0, -1) : currentVal + num;
    handleInputChange(r, c, newVal);
  }, [gameState, handleInputChange]);

  const getCanvasPos = (e, i) => {
    const canvas = canvasRefs[i].current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };

  const startDrawing = (e, i) => {
    if (gameState !== 'playing' || !settings.handwriting) return;
    e.preventDefault();
    isDrawingRef.current[i] = true;
    isDirtyRef.current[i] = true;
    if (ocrTimerRef.current) clearTimeout(ocrTimerRef.current);

    const pos = getCanvasPos(e, i);
    lastPosRef.current[i] = pos;
    drawOnCanvas(e, i);
  };

  const drawOnCanvas = (e, i) => {
    if (!isDrawingRef.current[i]) return;
    e.preventDefault();
    if (ocrTimerRef.current) clearTimeout(ocrTimerRef.current);

    const canvas = canvasRefs[i].current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pos = getCanvasPos(e, i);

    // 線の太さは canvas の実解像度に対する割合で決める。
    // 固定値にすると、DPR 補正で解像度が変わった端末だけ線が細くなり、
    // 28×28 に縮めたときの字の濃さが変わって認識率が落ちる
    ctx.lineWidth = Math.max(8, canvas.width * 0.1125);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#334155';

    ctx.beginPath();
    ctx.moveTo(lastPosRef.current[i].x, lastPosRef.current[i].y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();

    lastPosRef.current[i] = pos;
  };

  const stopDrawing = (e, i) => {
    if (!isDrawingRef.current[i]) return;
    isDrawingRef.current[i] = false;

    if (ocrTimerRef.current) clearTimeout(ocrTimerRef.current);
    // ref 経由で常に最新の認識処理を呼ぶ（古い state を掴まないように）
    ocrTimerRef.current = setTimeout(() => drawHandlersRef.current.recognizeHandwriting(), 400);
  };

  const preprocessCanvas = (sourceCanvas) => {
    if (!tfjs) return null;
    const sCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    const imgData = sCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const data = imgData.data;

    let minX = sourceCanvas.width, minY = sourceCanvas.height, maxX = 0, maxY = 0;
    let found = false;
    for (let y = 0; y < sourceCanvas.height; y++) {
      for (let x = 0; x < sourceCanvas.width; x++) {
        const idx = (y * sourceCanvas.width + x) * 4;
        if (data[idx + 3] > 0 && data[idx] < 128) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }
    if (!found) return null;

    const bWidth = maxX - minX + 1;
    const bHeight = maxY - minY + 1;
    const size = Math.max(bWidth, bHeight);
    const padding = size * 0.25;
    const paddedSize = size + padding * 2;

    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = paddedSize;
    tmpCanvas.height = paddedSize;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.fillStyle = '#ffffff';
    tmpCtx.fillRect(0, 0, paddedSize, paddedSize);

    const dx = padding + (size - bWidth) / 2;
    const dy = padding + (size - bHeight) / 2;
    tmpCtx.drawImage(sourceCanvas, minX, minY, bWidth, bHeight, dx, dy, bWidth, bHeight);

    const resizedCanvas = document.createElement('canvas');
    resizedCanvas.width = 28;
    resizedCanvas.height = 28;
    const resizedCtx = resizedCanvas.getContext('2d');
    resizedCtx.drawImage(tmpCanvas, 0, 0, paddedSize, paddedSize, 0, 0, 28, 28);

    const resizedData = resizedCtx.getImageData(0, 0, 28, 28).data;
    const input = new Float32Array(28 * 28);
    for (let i = 0; i < 28 * 28; i++) {
      const r = resizedData[i * 4];
      input[i] = (255 - r) / 255.0;
    }
    return tfjs.tensor4d(input, [1, 28, 28, 1]);
  };

  const recognizeHandwriting = async () => {
    const cell = activeCellRef.current;
    if (!settings.handwriting || !tfModel || !tfjs || !cell) return;

    let finalNumberStr = "";

    for (let i = 0; i < 2; i++) {
      if (isDirtyRef.current[i]) {
        let tensor = null;
        let output = null;
        try {
          tensor = preprocessCanvas(canvasRefs[i].current);
          if (!tensor) continue;

          output = tfModel.predict(tensor);
          // 中間テンサーを作らず一度だけ読み出す（メモリリーク防止）
          const probs = output.dataSync();
          let digit = 0;
          let probability = 0;
          for (let d = 0; d < probs.length; d++) {
            if (probs[d] > probability) {
              probability = probs[d];
              digit = d;
            }
          }

          if (probability > 0.4) {
            finalNumberStr += String(digit);
          }
        } catch (e) {
          console.error("推論エラー", e);
        } finally {
          if (tensor) tensor.dispose();
          if (output && output.dispose) output.dispose();
        }
      }
    }

    if (finalNumberStr.length > 0) {
      setAiStatus(<span>「{finalNumberStr}」を<ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby>しました</span>);
      handleInputChange(cell.r, cell.c, finalNumberStr);
    } else {
      setAiStatus(<span><ruby>数字<rp>(</rp><rt>すうじ</rt><rp>)</rp></ruby>がわかりませんでした</span>);
      clearAllCanvas();
    }
  };

  // 描画系ハンドラは毎レンダー作り直されるため、イベントリスナーからは
  // ref 経由で常に最新の関数を呼び出す（古い closure によるバグ防止）
  const drawHandlersRef = useRef({});
  useEffect(() => {
    drawHandlersRef.current = { startDrawing, drawOnCanvas, stopDrawing, recognizeHandwriting };
  });

  useEffect(() => {
    if (!settings.handwriting) return;

    const canvases = canvasRefs.map(ref => ref.current);
    const options = { passive: false };

    // 解除できるように同じ関数参照を保持する
    const touchStartHandlers = canvases.map((_, i) => (e) => drawHandlersRef.current.startDrawing(e, i));
    const touchMoveHandlers = canvases.map((_, i) => (e) => drawHandlersRef.current.drawOnCanvas(e, i));
    const handleGlobalUp = () => {
      drawHandlersRef.current.stopDrawing(null, 0);
      drawHandlersRef.current.stopDrawing(null, 1);
    };

    canvases.forEach((canvas, i) => {
      if (canvas) {
        canvas.addEventListener('touchstart', touchStartHandlers[i], options);
        canvas.addEventListener('touchmove', touchMoveHandlers[i], options);
      }
    });

    window.addEventListener('mouseup', handleGlobalUp);
    window.addEventListener('touchend', handleGlobalUp);
    return () => {
      canvases.forEach((canvas, i) => {
        if (canvas) {
          canvas.removeEventListener('touchstart', touchStartHandlers[i]);
          canvas.removeEventListener('touchmove', touchMoveHandlers[i]);
        }
      });
      window.removeEventListener('mouseup', handleGlobalUp);
      window.removeEventListener('touchend', handleGlobalUp);
    };
  }, [settings.handwriting]);

  const operatorSymbol = mode === 'たし算' ? '+' : mode === '引き算' ? '-' : '×';

  // 記録モーダルを開いたときだけ学習ログを読み直して集計する
  const studySummary = useMemo(() => {
    if (!showStats) return null;
    const recs = loadStudyRecords(APP_ID);
    return {
      byMode: summarizeByMode(recs),
      sessions: recs.length,
      studyMs: recs.reduce((sum, r) => sum + (r.activeMs ?? r.elapsedMs ?? 0), 0),
    };
  }, [showStats, records]);

  // 設問ID（8*9）は集計用の表記なので、表示のときだけ「×」に戻す
  const prettyQuestion = (q) => q.replace('*', '×');

  // 済んだマスの数（「のこり ○問」用）。
  // すぐ判定オンのときは「正解できたマス」、オフのときは「入力したマス」を数える。
  // ⚠️ オフのときに正解数を数えると、色を伏せても «のこり» が減らないことで
  //    まちがいが分かってしまう。数え方も終わり方に合わせる
  //    （オフの終了条件は「全部のマスが埋まったとき」）
  const solvedCount = useMemo(() => {
    let n = 0;
    for (let r = 0; r < tableData.rows.length; r++) {
      for (let c = 0; c < tableData.cols.length; c++) {
        const val = inputs[`${r}_${c}`];
        if (val === undefined || val === '') continue;
        if (!settings.autoScore || parseInt(val, 10) === getCorrectAnswer(r, c)) n++;
      }
    }
    return n;
  }, [inputs, tableData, getCorrectAnswer, settings.autoScore]);

  // app-shell = 100dvh。100vh はモバイルのアドレスバー分だけはみ出す（§2-2）
  return (
    <div className="app-shell bg-slate-100/50 text-slate-800 flex flex-col items-center">
      <style>{`
        /* touch-action / tap-highlight / ふりがなの色などの共通の土台は
           index.css（GIGA Standard Part I §2）に集約してある。
           ここには 100マス計算だけの見た目を置く。 */
        .btn-press { transition: all 0.1s; }
        .btn-press:active { transform: scale(0.95); }
        /* マスの大きさは画面幅から計算した --cell 変数で一括制御する */
        .sq-table th, .sq-table td {
          width: var(--cell, 48px);
          min-width: var(--cell, 48px);
          height: var(--cell, 48px);
          font-size: max(14px, calc(var(--cell, 48px) * 0.42));
        }
        .sq-table td input {
          /* 16px 未満だと iOS Safari がフォーカス時に画面を自動ズームしてしまうため下限 16px */
          font-size: max(16px, calc(var(--cell, 48px) * 0.42));
        }
        /* ソフトウェアキーボード抑止中（readOnly）のマス。長押しで文字選択ハンドルや
           コピー用メニューが出ると誤操作のもとなので、選択そのものを無効にする */
        .sq-table td input[readonly] {
          user-select: none;
          -webkit-user-select: none;
          -webkit-touch-callout: none;
        }
        /* 正誤は色だけで伝えない（§2-8）。面の色に加えて「線の形」でも分ける。
           正解＝実線の枠、まちがい＝破線の枠。色の見分けがつきにくい児童にも、
           ハイコントラストで面の色が消える端末（index.css の forced-colors）にも
           同じ手がかりが残る。
           ⚠️ border ではなく outline を使う。border を足すとマスの中で数字が
              1〜2px ずれて、100マスぜんぶがガタつく。 */
        .cell-correct {
          background-color: #dcfce7 !important; color: #166534; font-weight: bold;
          outline: 3px solid #15803d; outline-offset: -3px;
        }
        .cell-wrong {
          background-color: #fee2e2 !important; color: #991b1b;
          outline: 3px dashed #b91c1c; outline-offset: -3px;
        }
        @keyframes errorFlash {
          0% { background-color: #fca5a5; }
          100% { background-color: transparent; }
        }
        .cell-error-flash {
          animation: errorFlash 0.4s ease-out;
        }
        /* いま解いている計算式は児童がいちばん見る「主役」。
           320px のスマホから電子黒板まで clamp() 一本で通す（§2-4） */
        .current-problem { font-size: var(--fs-hero); font-family: var(--font-textbook); }
      `}</style>

      {/* 🔴 ヘッダー（操作類をここに集約して、下の計算ボードの縦空間を最大化する） */}
      <nav className="w-full bg-white border-b-4 border-slate-600 px-2 sm:px-4 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 shadow-sm z-30 sticky top-0">
        <h1 className="flex items-center gap-1.5 text-slate-700 font-bold text-lg mr-auto my-0">
          <Calculator className="w-5 h-5" aria-hidden="true" />
          <span className="whitespace-nowrap">100マス<ruby>計算<rp>(</rp><rt>けいさん</rt><rp>)</rp></ruby></span>
        </h1>

        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          <select aria-label="計算の種類" value={mode} onChange={handleModeChange} disabled={gameState === 'playing'} className="tap-44 bg-white border border-slate-300 rounded-lg px-2 py-1 text-sm font-bold text-slate-700 outline-none focus:border-slate-500 cursor-pointer">
            <option value="たし算">たし算</option>
            <option value="引き算">引き算</option>
            <option value="かけ算">かけ算</option>
          </select>
          <select aria-label="問題数" value={count} onChange={handleCountChange} disabled={gameState === 'playing'} className="tap-44 bg-white border border-slate-300 rounded-lg px-2 py-1 text-sm font-bold text-slate-700 outline-none focus:border-slate-500 cursor-pointer">
            {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(n => (
              <option key={n} value={n}>{n}問</option>
            ))}
          </select>

          <div className="text-xl font-bold text-slate-700 flex items-center gap-1 min-w-[5.5rem] justify-end">
            <Clock className="w-4 h-4 text-slate-500" />
            <span ref={timer.displayRef} className={gameState === 'playing' ? 'text-blue-600 tabular-nums' : 'tabular-nums'}>
              {gameState === 'result' ? timer.finalTime.toFixed(1) : "0.0"}
            </span>
            <span className="text-xs text-slate-500"><span><ruby>秒<rp>(</rp><rt>びょう</rt><rp>)</rp></ruby></span></span>
          </div>

          {gameState === 'idle' && (
            <button onClick={startGame} className="tap-44 btn-press bg-slate-700 text-white font-bold py-1.5 px-4 rounded-xl shadow-sm flex items-center gap-1.5 hover:bg-slate-800 text-sm whitespace-nowrap">
              <Play className="w-4 h-4 fill-current" aria-hidden="true" /> <span>スタート！</span>
            </button>
          )}
          {gameState === 'playing' && (
            <button onClick={() => setShowQuitConfirm(true)} className="tap-44 btn-press bg-white border-2 border-slate-300 text-slate-600 font-bold py-1 px-3 rounded-xl shadow-sm flex items-center gap-1.5 hover:bg-slate-50 text-sm whitespace-nowrap">
              <LogOut className="w-4 h-4" aria-hidden="true" /> <span>やめる</span>
            </button>
          )}
          {gameState === 'result' && (
            <button onClick={() => generateTable(mode, count)} className="tap-44 btn-press bg-blue-600 text-white font-bold py-1.5 px-4 rounded-xl shadow-sm flex items-center gap-1.5 hover:bg-blue-700 text-sm whitespace-nowrap">
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> <span>もう<ruby>一度<rp>(</rp><rt>いちど</rt><rp>)</rp></ruby></span>
            </button>
          )}

          {canInstall && (
            <button onClick={handleInstall} className="tap-44 btn-press bg-white border-2 border-slate-300 text-slate-700 font-bold py-1 px-3 rounded-xl shadow-sm flex items-center gap-1.5 hover:bg-slate-50 text-sm whitespace-nowrap">
              <Download className="w-4 h-4" aria-hidden="true" /> <span>アプリに<ruby>追加<rp>(</rp><rt>ついか</rt><rp>)</rp></ruby></span>
            </button>
          )}

          {/* 🖥️ 提示モード（§2-11）。電子黒板に映して一斉に取り組むときに使う */}
          <button onClick={togglePresentation} aria-pressed={presenting} className="tap-44 p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-full btn-press" title={presenting ? 'もとの大きさにもどす' : '大きく表示する（提示モード）'} aria-label={presenting ? 'もとの大きさにもどす' : '大きく表示する（提示モード）'}>
            {presenting
              ? <Minimize2 className="w-5 h-5" aria-hidden="true" />
              : <Maximize2 className="w-5 h-5" aria-hidden="true" />}
          </button>

          <button onClick={() => setShowStats(true)} className="tap-44 p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-full btn-press" title="記録" aria-label="これまでの記録をみる">
            <BarChart2 className="w-5 h-5" aria-hidden="true" />
          </button>
          <button onClick={() => setShowSettings(true)} className="tap-44 p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-full btn-press" title="設定" aria-label="設定をひらく">
            <Settings className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
      </nav>

      {/* 🟡 メインエリア */}
      <main className={`flex-grow w-full max-w-6xl p-2 sm:p-3 flex flex-col gap-3 items-start ${settings.inputPosition === 'left' ? 'lg:flex-row-reverse' : 'lg:flex-row'}`}>

        {/* 左側（または右側）：計算ボード
            print-board … 紙では余白・枠・影を落として、表そのものに紙幅を使う（§2-12） */}
        <div className="print-board w-full lg:flex-1 bg-white rounded-2xl shadow-sm border border-slate-200 p-2 sm:p-3">

          {gameState === 'result' && (
            <div className="mb-3 bg-slate-100 border-2 border-slate-300 rounded-xl p-3 text-center" role="status" aria-live="polite">
              <h2 className="text-xl font-bold text-slate-700 flex justify-center items-center gap-2">
                <Trophy className="w-6 h-6 text-slate-500" aria-hidden="true" />
                {resultScore === count ? (
                  <span>クリア！よく<ruby>頑張<rp>(</rp><rt>がんば</rt><rp>)</rp></ruby>ったね！</span>
                ) : (
                  <span>おわり！<ruby>正解<rp>(</rp><rt>せいかい</rt><rp>)</rp></ruby> {resultScore} / {count}<ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby></span>
                )}
              </h2>
              <p className="text-2xl font-bold text-slate-800 mt-1">
                タイム: <span className="text-blue-600 tabular-nums">{timer.finalTime.toFixed(1)}</span> <span><ruby>秒<rp>(</rp><rt>びょう</rt><rp>)</rp></ruby></span>
              </p>
            </div>
          )}

          <div ref={gridWrapRef} className="scroll-area overflow-x-auto pb-1">
            <table className="sq-table w-full border-collapse mx-auto bg-white select-none" style={{ minWidth: 'max-content', '--cell': `${cellSize}px` }}>
              <thead>
                <tr>
                  <th className="border-2 border-slate-300 bg-slate-200 text-slate-800 font-bold">{operatorSymbol}</th>
                  {tableData.cols.map((num, i) => (
                    <th key={`col-${i}`} className="border-2 border-slate-300 bg-slate-50 text-slate-700 font-bold">{num}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableData.rows.map((rowNum, r) => (
                  <tr key={`row-${r}`}>
                    <th className="border-2 border-slate-300 bg-slate-50 text-slate-700 font-bold">{rowNum}</th>
                    {tableData.cols.map((colNum, c) => {
                      const isActive = activeCell?.r === r && activeCell?.c === c;
                      return (
                        <Cell
                          key={`cell-${r}-${c}`}
                          r={r} c={c}
                          val={inputs[`${r}_${c}`] || ''}
                          ans={getCorrectAnswer(r, c)}
                          ariaLabel={`${rowNum} ${operatorSymbol} ${colNum}`}
                          isActive={isActive}
                          disabled={gameState !== 'playing'}
                          autoScore={settings.autoScore}
                          suppressOsKeyboard={settings.numpad || settings.handwriting}
                          onFocus={handleCellFocus}
                          onChange={handleInputChange}
                          onKeyDown={handleCellKeyDown}
                          inputRefs={inputRefs}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 右側（または左側）：入力支援ツール (手書き / テンキー)
            ⚠️ no-print が要る。先生が白紙のマスを刷って配るとき、手書き入力の枠が
               そのまま紙に出て 69mm（A4 の縦の 1/4）を食っていた。
               紙の上では手書きもテンキーも押せないので、まるごと落とす（§2-12）。 */}
        <div className="tool-column no-print w-full lg:w-80 flex flex-col gap-3 lg:sticky lg:top-14">

          {/* 🔍 いま解いている計算：手書き・テンキーのすぐ上に表示して、
              視線を動かさずに「何の計算をしているか」「あと何問か」がわかる */}
          {gameState === 'playing' && activeCell && (
            <div className="bg-blue-50 border-2 border-blue-200 rounded-xl px-3 sm:px-4 py-2 flex items-center justify-between gap-2 shadow-sm">
              <div className="current-problem font-bold text-slate-800 tabular-nums whitespace-nowrap leading-tight">
                {tableData.rows[activeCell.r]}
                <span className="text-blue-600 mx-1.5">{operatorSymbol}</span>
                {tableData.cols[activeCell.c]}
                <span className="mx-1.5">=</span>
                <span className="inline-block min-w-[2ch] border-b-4 border-blue-400 text-blue-700 text-center">
                  {inputs[`${activeCell.r}_${activeCell.c}`] || <span className="text-blue-500">?</span>}
                </span>
              </div>
              <div className="text-xs sm:text-sm font-bold text-slate-600 text-right whitespace-nowrap">
                <span>のこり</span> <span className="text-lg sm:text-xl text-slate-700 tabular-nums">{count - solvedCount}</span> <span><ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby></span>
              </div>
            </div>
          )}

          {/* 🖌️ 手書き入力エリア */}
          {settings.handwriting && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-sm font-bold text-slate-600 flex items-center gap-1">
                  <PenTool className="w-4 h-4" aria-hidden="true" /> <span><ruby>手書<rp>(</rp><rt>てが</rt><rp>)</rp></ruby>き<ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby></span>
                </h2>
                <button onMouseDown={(e) => e.preventDefault()} onClick={clearAllCanvas} className="tap-44 btn-press text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 px-3 py-1.5 rounded-full flex items-center gap-1 font-bold" aria-label="手書きした数字を消す">
                  <Eraser className="w-4 h-4" aria-hidden="true" /> <span><ruby>消<rp>(</rp><rt>け</rt><rp>)</rp></ruby>す</span>
                </button>
              </div>

              <div className="flex justify-center gap-3 mb-2">
                {[0, 1].map(i => (
                  <div key={i} className="flex-1 border-4 border-slate-200 rounded-2xl overflow-hidden bg-slate-50 touch-none" style={{ height: '160px' }}>
                    {/* width/height は fitCanvases が表示サイズ×dpr で設定する（§2-5）。
                        ここで固定値を書くと、その値で1フレーム描かれてぼやける */}
                    <canvas
                      ref={canvasRefs[i]}
                      aria-label="数字を手書きするところ"
                      className="canvas-area w-full h-full block cursor-crosshair"
                      onMouseDown={(e) => startDrawing(e, i)}
                      onMouseMove={(e) => drawOnCanvas(e, i)}
                      onMouseUp={(e) => stopDrawing(e, i)}
                      onMouseOut={(e) => stopDrawing(e, i)}
                    // Touch events are handled via standard addEventListener in useEffect for passive:false
                    />
                  </div>
                ))}
              </div>
              <div className="text-center text-sm font-bold text-slate-600 mt-2 h-5" role="status" aria-live="polite">{aiStatus}</div>
            </div>
          )}

          {/* ⌨️ ソフトウェアテンキー */}
          {settings.numpad && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
              <h2 className="text-sm font-bold text-slate-600 mb-4 flex items-center gap-1">
                <Keyboard className="w-4 h-4" aria-hidden="true" /> <span>ボタン<ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby></span>
              </h2>
              <div className="grid grid-cols-3 gap-3">
                {/* onMouseDown の preventDefault で、ボタンを押してもマスのフォーカスが外れないようにする */}
                {[7, 8, 9, 4, 5, 6, 1, 2, 3].map(num => (
                  <button key={num} onMouseDown={(e) => e.preventDefault()} onClick={() => handleNumpadInput(String(num))} className="btn-press h-16 bg-slate-50 hover:bg-slate-100 border-2 border-slate-200 rounded-xl text-3xl font-bold text-slate-700 shadow-sm">
                    {num}
                  </button>
                ))}
                <button onMouseDown={(e) => e.preventDefault()} onClick={() => handleNumpadInput('back')} className="btn-press h-16 bg-red-50 hover:bg-red-100 border-2 border-red-200 rounded-xl text-red-700 font-bold flex justify-center items-center shadow-sm text-lg">
                  <span><ruby>消<rp>(</rp><rt>け</rt><rp>)</rp></ruby>す</span>
                </button>
                <button onMouseDown={(e) => e.preventDefault()} onClick={() => handleNumpadInput('0')} className="btn-press h-16 bg-slate-50 hover:bg-slate-100 border-2 border-slate-200 rounded-xl text-3xl font-bold text-slate-700 shadow-sm">
                  0
                </button>
                <button onMouseDown={(e) => e.preventDefault()} onClick={() => { if (activeCell) moveToNextCell(activeCell.r, activeCell.c) }} className="btn-press h-16 bg-slate-200 hover:bg-slate-300 border-2 border-slate-300 rounded-xl text-slate-700 font-bold flex justify-center items-center shadow-sm text-lg">
                  <span><ruby>次<rp>(</rp><rt>つぎ</rt><rp>)</rp></ruby>へ</span> <ArrowRight className="w-5 h-5 ml-1" />
                </button>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* ⚠️ 1 行に収める。flex-nowrap と min-w-0 の 2 つが要る。nowrap だけだと、
          クレジットの文字列が縮まずに列を押し広げて横スクロールになる。
          狭い画面ではクレジットが … で切れる。ここが太ると、そのぶん
          マスを解く場所が狭くなる。 */}
      <footer className="no-print safe-bottom w-full flex flex-nowrap items-center justify-center gap-1 bg-white border-t border-slate-200 py-1 text-center text-sm text-slate-500 font-bold shadow-sm mt-auto">
        <span className="min-w-0 truncate">© 2026 100マス計算 <a href="https://giga-school.com" target="_blank" rel="noopener noreferrer" className="tap-44 inline-block text-slate-600 hover:underline">GIGA山</a></span>
        {/* ⚠️ 行き先のリンクを手で書かないこと。中身は正本の部品
            standards/web/giga-app-links.js（配布物 public/giga-app-links.js）が
            この中に出す。文言も並びも行き先も、あちらで決まっている。

            ⚠️ ここにあった「使い方を読む」（紹介記事へのリンク）は外した。
               紹介記事は「なぜ作ったか」を、まだ使っていない先生に向けて
               書いたもので、いま画面の前で困っている人が求めるものではない。
               艦隊のほかのアプリでも既に外れている。

            ⚠️ <div> にしないこと。そこで改行が入ってフッターが 2 行になる。

            ⚠️ data-links で「つかいかた」を外してある。このアプリにはまだ
               docs/manual/ が無く、既定のまま出すと行き止まりのリンクになる。
               マニュアルを書いたら、この属性ごと消すこと。 */}
        <span data-giga-links data-links="terms,privacy" />
      </footer>

      {/* 🔄 あたらしい版のおしらせ（§3-3）
          押されるまで切り替えない。計算の途中で入れ替わると、
          打ちかけの答えも計測中のタイムも消える。
          あとから足した固定要素なので .no-print を必ず付ける（§2-12） */}
      {updateReady && (
        <div className="no-print safe-bottom fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pt-3 pointer-events-none">
          <div role="status" aria-live="polite" className="pointer-events-auto bg-slate-800 text-white rounded-2xl shadow-xl px-4 py-3 flex items-center gap-3 max-w-md w-full">
            <Sparkles className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span className="text-sm font-bold flex-1">あたらしい ばんが あります</span>
            <button
              onClick={() => { setUpdateReady(false); window.__pwaAcceptUpdate?.(); }}
              className="tap-44 btn-press bg-white text-slate-800 font-bold text-sm px-3 py-1.5 rounded-xl whitespace-nowrap"
            >
              さいしんに する
            </button>
            <button
              onClick={() => setUpdateReady(false)}
              className="tap-44 text-slate-300 hover:text-white"
              aria-label="おしらせをとじる"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* 🚪 中断かくにんモーダル */}
      {showQuitConfirm && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div ref={quitBoxRef} role="dialog" aria-modal="true" aria-labelledby="quit-title" tabIndex={-1} className="bg-white rounded-2xl shadow-xl w-full max-w-xs overflow-hidden animate-[fadeIn_0.2s_ease-out]">
            <div className="p-5 text-center">
              <div id="quit-title" className="font-bold text-lg text-slate-700 mb-1"><span>とちゅうで やめますか？</span></div>
              <div className="text-xs text-slate-600"><span>ここまでの<ruby>記録<rp>(</rp><rt>きろく</rt><rp>)</rp></ruby>は<ruby>残<rp>(</rp><rt>のこ</rt><rp>)</rp></ruby>ります</span></div>
            </div>
            <div className="p-4 pt-0 flex gap-2">
              <button onClick={() => setShowQuitConfirm(false)} className="flex-1 btn-press bg-slate-700 text-white font-bold py-3 rounded-xl hover:bg-slate-800"><span>つづける</span></button>
              <button onClick={() => abortGame()} className="flex-1 btn-press bg-white border-2 border-slate-300 text-slate-600 font-bold py-3 rounded-xl hover:bg-slate-50"><span>やめる</span></button>
            </div>
          </div>
        </div>
      )}

      {/* ⚙️ 設定モーダル */}
      {showSettings && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div ref={settingsBoxRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden animate-[fadeIn_0.2s_ease-out]">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center">
              <h2 id="settings-title" className="font-bold text-slate-700 flex items-center gap-2"><Settings className="w-5 h-5 text-slate-600" aria-hidden="true" /> <span><ruby>設定<rp>(</rp><rt>せってい</rt><rp>)</rp></ruby></span></h2>
              <button onClick={() => setShowSettings(false)} className="tap-44 text-slate-500 hover:text-slate-700" aria-label="設定をとじる"><X className="w-6 h-6" aria-hidden="true" /></button>
            </div>
            <div className="p-4 flex flex-col gap-4">
              <label className="flex items-center justify-between p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                <div className="flex items-center gap-3">
                  {settings.sound ? <Volume2 className="w-5 h-5 text-blue-600" /> : <VolumeX className="w-5 h-5 text-slate-500" />}
                  <div>
                    <div className="font-bold text-slate-700"><span><ruby>音<rp>(</rp><rt>おと</rt><rp>)</rp></ruby>を<ruby>鳴<rp>(</rp><rt>な</rt><rp>)</rp></ruby>らす</span></div>
                    <div className="text-xs text-slate-600"><span><ruby>正解<rp>(</rp><rt>せいかい</rt><rp>)</rp></ruby>した<ruby>時<rp>(</rp><rt>とき</rt><rp>)</rp></ruby>に<ruby>音<rp>(</rp><rt>おと</rt><rp>)</rp></ruby>が<ruby>鳴<rp>(</rp><rt>な</rt><rp>)</rp></ruby>ります</span></div>
                  </div>
                </div>
                <input type="checkbox" checked={settings.sound} onChange={(e) => setSettings({ ...settings, sound: e.target.checked })} className="w-5 h-5 accent-slate-600 cursor-pointer" />
              </label>

              <label className="flex items-center justify-between p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                <div className="flex items-center gap-3">
                  <PenTool className="w-5 h-5 text-blue-600" />
                  <div>
                    <div className="font-bold text-slate-700"><span><ruby>手書<rp>(</rp><rt>てが</rt><rp>)</rp></ruby>き<ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby>を<ruby>使<rp>(</rp><rt>つか</rt><rp>)</rp></ruby>う</span></div>
                    <div className="text-xs text-slate-600"><span><ruby>画面<rp>(</rp><rt>がめん</rt><rp>)</rp></ruby>に<ruby>文字<rp>(</rp><rt>もじ</rt><rp>)</rp></ruby>を<ruby>書<rp>(</rp><rt>か</rt><rp>)</rp></ruby>いて<ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby>します</span></div>
                  </div>
                </div>
                <input type="checkbox" checked={settings.handwriting} onChange={(e) => setSettings({ ...settings, handwriting: e.target.checked })} className="w-5 h-5 accent-slate-600 cursor-pointer" />
              </label>

              <label className="flex items-center justify-between p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                <div className="flex items-center gap-3">
                  <Keyboard className="w-5 h-5 text-blue-600" />
                  <div>
                    <div className="font-bold text-slate-700"><span>ボタン<ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby>を<ruby>使<rp>(</rp><rt>つか</rt><rp>)</rp></ruby>う</span></div>
                    <div className="text-xs text-slate-600"><span><ruby>画面<rp>(</rp><rt>がめん</rt><rp>)</rp></ruby>にテンキーを<ruby>表示<rp>(</rp><rt>ひょうじ</rt><rp>)</rp></ruby>します</span></div>
                  </div>
                </div>
                <input type="checkbox" checked={settings.numpad} onChange={(e) => setSettings({ ...settings, numpad: e.target.checked })} className="w-5 h-5 accent-slate-600 cursor-pointer" />
              </label>

              <label className="flex items-center justify-between p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-blue-600" />
                  <div>
                    <div className="font-bold text-slate-700"><span>すぐ<ruby>判定<rp>(</rp><rt>はんてい</rt><rp>)</rp></ruby>（<ruby>自動採点<rp>(</rp><rt>じどうさいてん</rt><rp>)</rp></ruby>）</span></div>
                    <div className="text-xs text-slate-600"><span><ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby>した<ruby>瞬間<rp>(</rp><rt>しゅんかん</rt><rp>)</rp></ruby>に<ruby>丸<rp>(</rp><rt>まる</rt><rp>)</rp></ruby>つけをします</span></div>
                  </div>
                </div>
                <input type="checkbox" checked={settings.autoScore} onChange={(e) => setSettings({ ...settings, autoScore: e.target.checked })} className="w-5 h-5 accent-slate-600 cursor-pointer" />
              </label>

              <label className="flex items-center justify-between p-3 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors">
                <div className="flex items-center gap-3">
                  <MoveHorizontal className="w-5 h-5 text-blue-600" />
                  <div>
                    <div className="font-bold text-slate-700"><span><ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby>ツールの<ruby>位置<rp>(</rp><rt>いち</rt><rp>)</rp></ruby></span></div>
                    <div className="text-xs text-slate-600"><span><ruby>手書<rp>(</rp><rt>てが</rt><rp>)</rp></ruby>きやボタンの<ruby>場所<rp>(</rp><rt>ばしょ</rt><rp>)</rp></ruby>を<ruby>選<rp>(</rp><rt>えら</rt><rp>)</rp></ruby>びます</span></div>
                  </div>
                </div>
                <select
                  aria-label="入力ツールの位置"
                  value={settings.inputPosition || 'right'}
                  onChange={(e) => setSettings({ ...settings, inputPosition: e.target.value })}
                  className="tap-44 bg-white border border-slate-300 rounded-lg px-2 py-1 text-sm font-bold text-slate-700 outline-none focus:border-slate-500 cursor-pointer"
                >
                  <option value="right">右側</option>
                  <option value="left">左側</option>
                </select>
              </label>
            </div>
            <div className="p-4 pt-0">
              <button onClick={() => setShowSettings(false)} className="w-full btn-press bg-slate-700 text-white font-bold py-3 rounded-xl hover:bg-slate-800"><span><ruby>閉<rp>(</rp><rt>と</rt><rp>)</rp></ruby>じる</span></button>
            </div>
          </div>
        </div>
      )}

      {/* 📊 記録モーダル */}
      {showStats && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div ref={statsBoxRef} role="dialog" aria-modal="true" aria-labelledby="stats-title" tabIndex={-1} className="modal-shell bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-[fadeIn_0.2s_ease-out] flex flex-col">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center shrink-0">
              <h2 id="stats-title" className="font-bold text-slate-700 flex items-center gap-2"><BarChart2 className="w-5 h-5 text-slate-600" aria-hidden="true" /> <span>これまでの<ruby>記録<rp>(</rp><rt>きろく</rt><rp>)</rp></ruby></span></h2>
              <button onClick={() => setShowStats(false)} className="tap-44 text-slate-500 hover:text-slate-700" aria-label="記録をとじる"><X className="w-6 h-6" aria-hidden="true" /></button>
            </div>

            <div className="scroll-area p-4 overflow-y-auto">
              {studySummary && studySummary.sessions > 0 && (
                <div className="bg-slate-800 text-white rounded-xl p-3 mb-5 flex justify-around text-center">
                  <div>
                    <div className="text-xs text-slate-300 font-bold"><span>とりくんだ<ruby>回数<rp>(</rp><rt>かいすう</rt><rp>)</rp></ruby></span></div>
                    <div className="text-2xl font-bold tabular-nums">{studySummary.sessions}<span className="text-sm ml-0.5"><ruby>回<rp>(</rp><rt>かい</rt><rp>)</rp></ruby></span></div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-300 font-bold"><span><ruby>勉強<rp>(</rp><rt>べんきょう</rt><rp>)</rp></ruby>した<ruby>時間<rp>(</rp><rt>じかん</rt><rp>)</rp></ruby></span></div>
                    <div className="text-2xl font-bold tabular-nums">{formatDuration(studySummary.studyMs)}</div>
                  </div>
                </div>
              )}

              {['たし算', '引き算', 'かけ算'].map(calcMode => {
                const study = studySummary?.byMode?.[MODE_ID[calcMode]];
                return (
                <div key={calcMode} className="mb-6 last:mb-0">
                  <h3 className="font-bold text-lg text-slate-700 border-b-2 border-slate-200 pb-1 mb-3">
                    {calcMode === 'たし算' ? <span>たし<ruby>算<rp>(</rp><rt>ざん</rt><rp>)</rp></ruby></span> : calcMode === '引き算' ? <span><ruby>引<rp>(</rp><rt>ひ</rt><rp>)</rp></ruby>き<ruby>算<rp>(</rp><rt>ざん</rt><rp>)</rp></ruby></span> : <span>かけ<ruby>算<rp>(</rp><rt>ざん</rt><rp>)</rp></ruby></span>}
                  </h3>

                  <div className="bg-slate-50 rounded-xl p-3 mb-3 border border-slate-200">
                    <div className="text-xs font-bold text-slate-500 flex items-center gap-1 mb-2"><Trophy className="w-4 h-4" /> <span>ベストタイム</span></div>
                    <div className="flex gap-4 flex-wrap">
                      {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(c => records[calcMode].best[c] && (
                        <div key={`best-${c}`} className="bg-white px-2 py-1 rounded shadow-sm text-sm border border-slate-200">
                          <span className="text-slate-500 text-xs mr-1"><span>{c}<ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby>:</span></span>
                          <span className="font-bold text-blue-600"><span>{records[calcMode].best[c].toFixed(1)}<ruby>秒<rp>(</rp><rt>びょう</rt><rp>)</rp></ruby></span></span>
                        </div>
                      ))}
                      {Object.keys(records[calcMode].best).length === 0 && <span className="text-sm text-slate-500"><span>まだ<ruby>記録<rp>(</rp><rt>きろく</rt><rp>)</rp></ruby>がありません</span></span>}
                    </div>
                  </div>

                  {/* 📈 学習ログ (study.v1) からの集計。
                      正解するまで次に進めない設計のため「正解数」は満点になりがち。
                      実力を映すのは「初回で正解できたか」の方 */}
                  {study && study.firstTryRate !== null && (
                    <div className="bg-blue-50 rounded-xl p-3 mb-3 border border-blue-200">
                      <div className="text-xs font-bold text-slate-600 flex items-center gap-1 mb-1">
                        <Target className="w-4 h-4" />
                        <span><ruby>一発<rp>(</rp><rt>いっぱつ</rt><rp>)</rp></ruby>で<ruby>正解<rp>(</rp><rt>せいかい</rt><rp>)</rp></ruby>できた<ruby>率<rp>(</rp><rt>りつ</rt><rp>)</rp></ruby>（さいきん{study.recentSessions}<ruby>回<rp>(</rp><rt>かい</rt><rp>)</rp></ruby>）</span>
                      </div>
                      <div className="flex items-end gap-2">
                        <span className="text-3xl font-bold text-blue-700 tabular-nums">{Math.round(study.firstTryRate * 100)}%</span>
                        <span className="text-xs text-slate-600 mb-1 tabular-nums">{study.recentFirstTryCorrect} / {study.recentAttempted}<ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby></span>
                      </div>
                      <div className="h-2 bg-white rounded-full overflow-hidden mt-1.5 border border-blue-100">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.round(study.firstTryRate * 100)}%` }} />
                      </div>

                      {study.weak.length > 0 && (
                        <div className="mt-3">
                          <div className="text-xs font-bold text-slate-600 flex items-center gap-1 mb-1.5">
                            <Flame className="w-4 h-4" /> <span>よく<ruby>間違<rp>(</rp><rt>まちが</rt><rp>)</rp></ruby>えた<ruby>計算<rp>(</rp><rt>けいさん</rt><rp>)</rp></ruby></span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {study.weak.map(w => (
                              <span key={w.q} className="bg-white border border-orange-200 text-slate-700 rounded-lg px-2 py-1 text-sm font-bold shadow-sm tabular-nums">
                                {prettyQuestion(w.q)}
                                <span className="text-orange-700 text-xs ml-1">{w.n}<ruby>回<rp>(</rp><rt>かい</rt><rp>)</rp></ruby></span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {study.aborted > 0 && (
                        <div className="text-xs text-slate-600 mt-2">
                          <span>とちゅうでやめた<ruby>回数<rp>(</rp><rt>かいすう</rt><rp>)</rp></ruby>: {study.aborted}<ruby>回<rp>(</rp><rt>かい</rt><rp>)</rp></ruby></span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="text-xs font-bold text-slate-500 flex items-center gap-1 mb-2"><History className="w-4 h-4" /> <span><ruby>最近<rp>(</rp><rt>さいきん</rt><rp>)</rp></ruby>の<ruby>記録<rp>(</rp><rt>きろく</rt><rp>)</rp></ruby>（20<ruby>回<rp>(</rp><rt>かい</rt><rp>)</rp></ruby>）</span></div>
                  {records[calcMode].history.length > 0 ? (
                    <ul className="space-y-2">
                      {records[calcMode].history.map((hist, i) => (
                        <li key={i} className="flex justify-between items-center text-sm bg-white border border-slate-100 shadow-sm px-3 py-2 rounded-lg">
                          <span className="text-slate-500">{hist.date}</span>
                          <div>
                            <span className="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs mr-2"><span>{hist.count}<ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby></span></span>
                            <span className="font-bold text-slate-700 tabular-nums"><span>{hist.time.toFixed(1)}<ruby>秒<rp>(</rp><rt>びょう</rt><rp>)</rp></ruby></span></span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-slate-500 text-center py-2"><span>まだ<ruby>記録<rp>(</rp><rt>きろく</rt><rp>)</rp></ruby>がありません</span></div>
                  )}
                </div>
                );
              })}
            </div>

            <div className="p-4 pt-0 shrink-0 mt-4">
              <button onClick={() => setShowStats(false)} className="w-full btn-press bg-slate-800 text-white font-bold py-3 rounded-xl hover:bg-slate-900"><span><ruby>閉<rp>(</rp><rt>と</rt><rp>)</rp></ruby>じる</span></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
