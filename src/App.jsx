import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { Calculator, Settings, Play, RefreshCw, Trophy, History, X, CheckCircle, Volume2, VolumeX, Keyboard, BarChart2, Clock, ArrowRight, PenTool, Eraser, MoveHorizontal, Target, LogOut, Flame, Download, Sparkles, Maximize2, Minimize2, EyeOff, Grid3x3, Check, Hourglass } from 'lucide-react';
import {
  APP_ID, MODE_ID, answerOf, inputMethodOf, allCellKeys,
  createStudySession, recordAttempt, markCellTiming, finalizeStudySession,
} from './studySession';
import { loadStudyRecords, summarizeByMode, formatDuration } from './studyStats';
import { isStandalone, keepLoadedFilesOffline } from './pwa';
import { makeCols, pickRows, rowPool, maxCount } from './board';
import { splitTime, splitRemaining, minuteReading, limitLabel } from './timeText';

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

// ==========================================
// ⚡ カスタムフック: タイマー
// ==========================================
// 計るのは performance.now() の差だけ。画面に描くのは、下の RunningClock が受け持つ。
const useHighResTimer = () => {
  const startTimeRef = useRef(0);
  const [finalTime, setFinalTime] = useState(0);

  const start = useCallback(() => {
    startTimeRef.current = performance.now();
    setFinalTime(0);
  }, []);

  // 経過時間を止めずに読む（中断時に「タブを離れた時刻」を控えるのに使う）
  const peek = useCallback(() => (performance.now() - startTimeRef.current) / 1000, []);

  // atSeconds を渡すと、その時点で止めたものとして締める。
  // タブを離れたまま戻らなかった中断で、待っていた時間を含めないために使う
  const stop = useCallback((atSeconds) => {
    const final = atSeconds !== undefined
      ? atSeconds
      : (performance.now() - startTimeRef.current) / 1000;
    setFinalTime(final);
    return final;
  }, []);

  const reset = useCallback(() => { setFinalTime(0); }, []);

  return useMemo(
    () => ({ start, stop, peek, reset, finalTime }),
    [start, stop, peek, reset, finalTime]
  );
};

// ==========================================
// 🕒 タイムの表示
// ==========================================
// 60 秒以上は「2分5.3秒」の形で出す。
// 以前は何分かかっても「612.4秒」と出していた。100問に 10 分かかる子は、
// 自分のタイムを読めなかった。分け方と「分」の読みは src/timeText.js にある。
// whole を付けると、秒を整数で出す（のこり時間の表示に使う）。
// compact も付けると、ちょうどの分のときに「0秒」を出さない（「2分」。制限時間の名前に使う）
const TimeText = ({ sec, whole = false, compact = false, unitClassName = '' }) => {
  const { minutes, seconds } = whole ? splitRemaining(sec) : splitTime(sec);
  if (compact && minutes > 0 && seconds === 0) {
    return (
      <span className="tabular-nums whitespace-nowrap">
        {minutes}
        <span className={unitClassName}><ruby>分<rp>(</rp><rt>{minuteReading(minutes)}</rt><rp>)</rp></ruby></span>
      </span>
    );
  }
  return (
    <span className="tabular-nums whitespace-nowrap">
      {minutes > 0 && (
        <>
          {minutes}
          <span className={unitClassName}><ruby>分<rp>(</rp><rt>{minuteReading(minutes)}</rt><rp>)</rp></ruby></span>
        </>
      )}
      {whole ? seconds : seconds.toFixed(1)}
      <span className={unitClassName}><ruby>秒<rp>(</rp><rt>びょう</rt><rp>)</rp></ruby></span>
    </span>
  );
};

// ヘッダーのタイムで、単位（分・秒）だけを小さく出すための指定
const CLOCK_UNIT_CLASS = 'text-xs text-slate-500 ml-0.5';

// 動いているあいだのタイムを描く小さな部品。
// ⚠️ この数字を App の state にしないこと。App ごと 1 秒に 10 回描き直され、
//    そのたびに 100 マスぶんの比較が走る。描き直すのは、この部品だけにする。
const RunningClock = memo(({ getSeconds, whole = false, unitClassName }) => {
  const [sec, setSec] = useState(() => getSeconds());
  useEffect(() => {
    let frame;
    let shown = null;
    const tick = () => {
      const now = getSeconds();
      // 表示が変わるときだけ描き直す（0.1 秒きざみ。のこり時間は 1 秒きざみ）
      const key = whole ? Math.ceil(now) : Math.floor(now * 10);
      if (key !== shown) {
        shown = key;
        setSec(now);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getSeconds, whole]);
  return <TimeText sec={sec} whole={whole} unitClassName={unitClassName} />;
});

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

// ⏳ 選べる制限時間（秒）。0 は「なし」
const TIME_LIMITS = [0, 60, 120, 180, 300, 600];

// かけ算で「だん」を選んでいないときの、空の一覧（毎回おなじ配列を使い、描き直しを増やさない）
const NO_DAN = [];

// 選んだ「だん」の書き方。例: [7] → 「7のだん」、[6, 7, 8] → 「6・7・8のだん」
// 4 つ以上は長くなるので数だけにする（ヘッダーが折り返すと、マスを解く場所が狭くなる）
const danLabel = (dan) => {
  if (!dan || dan.length === 0) return 'だん: ぜんぶ';
  if (dan.length <= 3) return `${dan.join('・')}のだん`;
  return `だん: ${dan.length}こ`;
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

  // とりくんでいる間に、もう正解しているマス（すぐ判定オン）。
  //
  // ⚠️ 押しても何も起きないようにしておく（input は pointer-events を切り、td の mousedown は
  //    既定の動きを止める）。disabled にしてあるだけだと、押したときに pointerdown は届いて
  //    枠がそこへ移り、フォーカスはどのマスにも無くなる。テンキーもキーボードも効かず、
  //    未回答のマスを押し直すまで何も入らなくなっていた（実測 2026-11-16）。
  const solved = !disabled && autoScore && val !== '' && parseInt(val, 10) === ans;

  return (
    <td
      className={`border-2 border-slate-300 p-0 relative ${isActive ? 'ring-2 ring-slate-500 z-10' : ''}`}
      onMouseDown={solved ? (e) => e.preventDefault() : undefined}
    >
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
        disabled={disabled || solved}
        // readOnly なマスに focus が飛ばない端末でも「いま解いているマス」が
        // 切り替わるように、タップ時点でも対象セルを確定させる
        onPointerDown={() => { if (!isActive) onFocus(r, c); }}
        onFocus={() => onFocus(r, c)}
        onChange={(e) => onChange(r, c, e.target.value)}
        onKeyDown={(e) => onKeyDown(e, r, c)}
        className={`text-center font-bold outline-none bg-transparent transition-colors ${cellClass} ${flash ? 'cell-error-flash' : ''}`}
        style={{ width: '100%', height: '100%', pointerEvents: solved ? 'none' : undefined }}
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
      inputPosition: 'right',
      // とりくんでいる間、タイムを出さない（時間が気になってあせる子のため）
      hideTimer: false,
      // 制限時間（秒）。0 なら制限なし。時間になったところで終わり、「○分で ○問」を残す
      timeLimit: 0
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
  // 「丸つけ する」を、空いているマスが残ったまま押したときの確かめ
  const [showGradeConfirm, setShowGradeConfirm] = useState(false);

  // 🔢 かけ算で、左に出す数（だん）を選んだもの。空なら、ぜんぶのだんから出す。
  //    九九は 1 つのだんずつ習うので、「7のだんだけ」「6・7・8のだんだけ」を練習できるようにする。
  //    計算の種類・問題数と同じ「いまの出題」の一部なので、端末には保存しない
  const [dan, setDan] = useState(NO_DAN);
  const [showDan, setShowDan] = useState(false);
  // 選ぶ画面の中で、押している途中の選び方（「きめる」を押すまで出題は変えない）
  const [danDraft, setDanDraft] = useState(NO_DAN);
  // だんが効くのは、かけ算のときだけ
  const activeDan = mode === 'かけ算' ? dan : NO_DAN;

  // ⏳ いまの回（終わったあとは、終わった回）に効いている制限時間（秒）。0 なら制限なし。
  //    スタートのときに設定から写す。とちゅうで設定を変えても、その回の約束は変えない
  const [activeLimit, setActiveLimit] = useState(0);
  const activeLimitRef = useRef(0);
  // 時間になって終わったか（結果の出し方を変える）
  const [timedOut, setTimedOut] = useState(false);

  const settingsBoxRef = useRef(null);
  const statsBoxRef = useRef(null);
  const quitBoxRef = useRef(null);
  const gradeBoxRef = useRef(null);
  const danBoxRef = useRef(null);
  useModalFocus(danBoxRef, showDan);
  useModalFocus(settingsBoxRef, showSettings);
  useModalFocus(statsBoxRef, showStats);
  useModalFocus(quitBoxRef, showQuitConfirm);
  useModalFocus(gradeBoxRef, showGradeConfirm);

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
    // best       … ぜんぶ正解で終えたときのベストタイム（問題数ごと）
    // bestSolved … 制限時間つきで、時間になるまでに正解できた数のさいこう（制限時間ごと）
    // history    … 最近の 20 回（ぜんぶ正解で終えた回と、時間になって終わった回）
    const defaults = {
      'たし算': { best: {}, history: [], bestSolved: {} },
      '引き算': { best: {}, history: [], bestSolved: {} },
      'かけ算': { best: {}, history: [], bestSolved: {} },
    };
    try {
      const parsed = JSON.parse(localStorage.getItem('giga_calc_records_v4') || 'null');
      if (parsed) {
        for (const key of Object.keys(defaults)) {
          if (parsed[key]) {
            defaults[key] = {
              best: parsed[key].best || {},
              history: Array.isArray(parsed[key].history) ? parsed[key].history : [],
              bestSolved: parsed[key].bestSolved || {}
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
  const danRef = useRef(activeDan);
  const countRef = useRef(count);
  const settingsRef = useRef(settings);
  useEffect(() => {
    tableDataRef.current = tableData;
    modeRef.current = mode;
    danRef.current = activeDan;
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

    generateTable(mode, count, activeDan);

    return () => {
      window.removeEventListener('touchstart', handleUserInteraction);
      window.removeEventListener('mousedown', handleUserInteraction);
      window.removeEventListener('keydown', handleUserInteraction);
    };
  }, []);

  // ⚠️ 書き込みは必ず try で受ける。読み込み（上の useState）は受けてあったが、
  //    書き込みは受けておらず、保存領域に書けない端末では effect が例外を投げて
  //    React が画面ごと外し、真っ白になっていた（実測 2026-11-15。容量がいっぱいの
  //    とき、サイトデータの保存を止めてある端末のとき、の両方）。
  //    書けなくても計算はできる。設定と記録が次に開いたときに残らないだけ。
  useEffect(() => {
    try {
      localStorage.setItem('giga_calc_settings_v4', JSON.stringify(settings));
    } catch (e) {
      console.warn('設定を保存できませんでした:', e);
    }
  }, [settings]);

  useEffect(() => {
    try {
      localStorage.setItem('giga_calc_records_v4', JSON.stringify(records));
    } catch (e) {
      console.warn('記録を保存できませんでした:', e);
    }
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
    if (!showSettings && !showStats && !showQuitConfirm && !showGradeConfirm && !showDan) return;
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        setShowSettings(false);
        setShowStats(false);
        setShowQuitConfirm(false);
        setShowGradeConfirm(false);
        setShowDan(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [showSettings, showStats, showQuitConfirm, showGradeConfirm, showDan]);

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
      // はじめて開いた端末でも、次からは圏外で手書きが使えるようにする（src/pwa.js）
      keepLoadedFilesOffline();
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
    if (ocrTimerRef.current) {
      clearTimeout(ocrTimerRef.current);
      ocrTimerRef.current = null;
    }
  }, []);

  // 読み取りの予約が残っていれば、待たずに、いま読み取る。
  //
  // ⚠️ 読み取りは「指を離して 0.4 秒後」に走る。その前に「次へ」「丸つけ する」や別のマスを
  //    押すと、フォーカスの移動が予約ごと線を消し、書いた答えが捨てられていた
  //    （実測 2026-11-16: 離して 0.15〜0.34 秒で「次へ」を押すと、マスは空のまま枠だけ進む）。
  //    すぐ判定オフでは「書く → 次へ」を毎マスくり返すので、手の早い子ほど答えが入らない。
  //    押した時点で読み取りを済ませてから、その操作をつづける。
  const flushHandwriting = useCallback(() => {
    if (!ocrTimerRef.current) return;
    clearTimeout(ocrTimerRef.current);
    ocrTimerRef.current = null;
    // 読み取りは同期で終わる（待つ処理が無い）ので、戻った時点でマスに値が入っている
    drawHandlersRef.current.recognizeHandwriting?.();
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
  // timeUp: 制限時間になって終わったか（学習ログの ext.timeUp に残す）
  const saveSession = useCallback((status, exactTimeSec, timeUp = false) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    finalizeStudySession(session, {
      status,
      timeUp,
      elapsedMs: Math.max(0, exactTimeSec - session.startOffsetSec) * 1000,
      activeMs: activeTimer.stop(),
      inputs: inputsRef.current,
      prevBestSec: recordsRef.current?.[session.mode]?.best?.[session.cells],
    });
  }, [activeTimer]);

  // currentDan: かけ算で選んだ「だん」。選んでいなければ空（ぜんぶのだんから出す）
  const generateTable = useCallback((currentMode, currentCount, currentDan = NO_DAN) => {
    const rowsCount = currentCount / 10;

    // 上は 0〜9 を並べかえた 10 個。左は同じ数が重ならないように選ぶ（src/board.js）
    const newCols = makeCols();
    const newRows = pickRows(currentMode, rowsCount, currentMode === 'かけ算' ? currentDan : NO_DAN);

    setTableData({ rows: newRows, cols: newCols });
    setInputs({});
    inputsRef.current = {};
    sessionRef.current = null;
    setGameState('idle');
    setResultScore(null);
    setTimedOut(false);
    timer.reset();
    clearAllCanvas();
  }, [timer.reset, clearAllCanvas]);

  const handleModeChange = (e) => {
    const newMode = e.target.value;
    // かけ算へ戻ったとき、選んであるだんの数より多い行は作れない（同じ行を 2 つ出さない）
    const newCount = Math.min(count, maxCount(newMode, newMode === 'かけ算' ? dan : NO_DAN));
    setMode(newMode);
    if (newCount !== count) setCount(newCount);
    generateTable(newMode, newCount, dan);
  };

  const handleCountChange = (e) => {
    const newCount = parseInt(e.target.value, 10);
    setCount(newCount);
    generateTable(mode, newCount, dan);
  };

  // だんを選ぶ画面をひらく・きめる
  const openDan = () => {
    setDanDraft(dan);
    setShowDan(true);
  };
  const toggleDanDraft = (n) => {
    setDanDraft((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b)));
  };
  const applyDan = () => {
    // 10 こ ぜんぶ えらんだときは、えらんでいないのと同じ盤面になる。「ぜんぶ」にそろえる
    // （えらんだ回あつかいにすると、同じ盤面なのにベストタイムに入らなくなる）
    const all = danDraft.length >= rowPool('かけ算').length;
    const picked = danDraft.length && !all ? danDraft : NO_DAN;
    // 選んだだんが、ぜんぶ出る問題数にする（7のだんだけなら 10問、3つなら 30問）。
    // 選ぶのをやめたときは、問題数はそのまま
    const newCount = picked.length ? picked.length * 10 : count;
    setDan(picked);
    setShowDan(false);
    if (newCount !== count) setCount(newCount);
    generateTable(mode, newCount, picked);
  };

  const startGame = () => {
    initAudioContext();
    setGameState('playing');
    setInputs({});
    inputsRef.current = {};
    setResultScore(null);
    setTimedOut(false);
    // この回の制限時間を決める（設定をとちゅうで変えても、この回は変えない）
    const limitSec = settings.timeLimit || 0;
    setActiveLimit(limitSec);
    activeLimitRef.current = limitSec;
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
      dan: activeDan,
      timeLimitSec: limitSec,
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
      // だんを選んだ回には、どのだんだったかを残す（最近の記録に「7のだん」と出す）
      const picked = activeDan.length > 0;
      if (picked) newRecord.dan = activeDan;

      setRecords(prev => {
        const modeData = prev[mode];
        const newHistory = [newRecord, ...modeData.history].slice(0, 20);
        // ⚠️ だんを選んだ回は、ベストタイムに入れない。
        //    ベストタイムは「計算の種類 × 問題数」で 1 つ。1 のだんだけで出したタイムが
        //    そこへ入ると、ぜんぶのだんから出したときのタイムと比べられなくなる
        if (picked) {
          return { ...prev, [mode]: { ...modeData, history: newHistory } };
        }
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
  }, [count, mode, activeDan, settings.sound, timer.stop, saveSession]);

  // 途中でやめた記録も残す（study.v1 §5.4）。
  // 「難しすぎる」「量が多すぎる」という重要なサインなので、捨ててはならない。
  // atSeconds を渡すと、その時点で締める（タブ離脱による中断で使う）
  const abortGame = useCallback((atSeconds) => {
    setShowQuitConfirm(false);
    setShowGradeConfirm(false);
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
        dan: danRef.current,
        timeLimitSec: activeLimitRef.current,
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

  // 入力ずみのマスの数と、そのうち正解しているマスの数
  const countAnswers = useCallback((allInputs) => {
    let answered = 0;
    let correct = 0;
    for (let r = 0; r < tableData.rows.length; r++) {
      for (let c = 0; c < tableData.cols.length; c++) {
        const val = allInputs[`${r}_${c}`];
        if (val === undefined || val === '') continue;
        answered++;
        if (parseInt(val, 10) === getCorrectAnswer(r, c)) correct++;
      }
    }
    return { answered, correct };
  }, [tableData, getCorrectAnswer]);

  // すぐ判定オンで、もう正解しているマスか。正解したマスは入力を受けつけない
  // （Cell の側でも disabled になる）。すぐ判定オフでは、どのマスも書き直せる
  const isSolvedCell = useCallback((r, c) => {
    if (!settings.autoScore) return false;
    const val = inputsRef.current[`${r}_${c}`];
    return val !== undefined && val !== '' && parseInt(val, 10) === getCorrectAnswer(r, c);
  }, [settings.autoScore, getCorrectAnswer]);

  // 「いま解いているマス」を移す。枠（activeCell）とフォーカスを必ずそろえて動かす
  const focusCell = useCallback((r, c) => {
    const cell = { r, c };
    setActiveCell(cell);
    activeCellRef.current = cell;
    inputRefs.current[`${r}_${c}`]?.focus();
  }, []);

  // force: 入力途中でも「全マス回答済みなら採点してよい」とみなすか
  // （Enter や「次へ」で明示的に確定した時に true）
  const checkCompletion = useCallback((newInputs, force = false) => {
    const { answered: answeredCount, correct: correctCount } = countAnswers(newInputs);

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
  }, [count, countAnswers, stopGame, settings.autoScore]);

  const moveToNextCell = useCallback((r, c) => {
    // 確定操作（Enter / 次へ / →）の時点で全マス回答済みなら採点する
    checkCompletion(inputsRef.current, true);
    if (!runningRef.current) return; // 採点でゲームが終了した

    // 次に進むマスを、読む順（左から右・上から下）に探す。
    // 表の最後まで行ったら、先頭へ戻って探しつづける。
    //
    // ⚠️ 最後のマスで止めてはいけない。以前は止めていたので、マスを飛ばして
    //    最後まで解くと、枠が正解ずみの最後のマスに残った。そのままテンキーを押すと
    //    正解ずみの答えが消えていた（実測 2026-11-15: のこり 1問 → 2問）。
    const colsN = tableData.cols.length;
    const total = tableData.rows.length * colsN;
    const start = r * colsN + c;
    for (let step = 1; step < total; step++) {
      const idx = (start + step) % total;
      const nextR = Math.floor(idx / colsN);
      const nextC = idx % colsN;
      const wrapped = start + step >= total;
      const val = inputsRef.current[`${nextR}_${nextC}`];
      const filled = val !== undefined && val !== '';
      // すぐ判定オン: もう正解しているマスは飛ばす。
      // すぐ判定オフ: となりのマスへ進む（書き直せるので飛ばさない）。ただし
      //   先頭へ戻ったあとは、まだ空いているマスまで飛ぶ
      const skip = settings.autoScore ? isSolvedCell(nextR, nextC) : (wrapped && filled);
      if (!skip) {
        focusCell(nextR, nextC);
        return;
      }
    }
    // 進める先が無い（のこっているのは、いまのマスだけ）
  }, [tableData, settings.autoScore, isSolvedCell, focusCell, checkCompletion]);

  const handleInputChange = useCallback((r, c, value) => {
    if (gameState !== 'playing') return;
    // 正解ずみのマスには書きこまない（すぐ判定オン）。
    // テンキーと手書きは「いま解いているマス」へ書くので、枠が正解ずみのマスに
    // あると、そこへ足した数字が「まちがい」になって答えごと消えてしまう
    if (isSolvedCell(r, c)) return;

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
  }, [gameState, getCorrectAnswer, settings, moveToNextCell, checkCompletion, clearAllCanvas, isSolvedCell]);

  const handleCellFocus = useCallback((r, c) => {
    // 別のマスへ移る前に、書きかけの手書きを「いままでのマス」へ読み取っておく。
    // （読み取った答えが正解で次のマスへ進んだ場合も、このあと、押されたマスへ移る）
    const prev = activeCellRef.current;
    if (prev && (prev.r !== r || prev.c !== c)) flushHandwriting();
    const cell = { r, c };
    setActiveCell(cell);
    activeCellRef.current = cell;
    markCellTiming(sessionRef.current, `${r}_${c}`);
    clearAllCanvas();
  }, [clearAllCanvas, flushHandwriting]);

  // 「次へ」ボタン・Enter・→ で、いまのマスから次へ進む。
  // 書きかけの手書きがあれば、先に読み取る。読み取った答えが正解で、もう次のマスへ
  // 進んでいたときは、それ以上は進めない（2 マス進んでしまう）
  const advanceByUser = useCallback(() => {
    const before = activeCellRef.current;
    if (!before) return;
    flushHandwriting();
    if (!runningRef.current) return;      // 読み取った答えで、全部そろって終わった
    const now = activeCellRef.current;
    if (!now || now.r !== before.r || now.c !== before.c) return;
    moveToNextCell(now.r, now.c);
  }, [flushHandwriting, moveToNextCell]);

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

    // ⚠️ ←・↑・↓ は、正解ずみのマスを飛ばして「入力できるマス」まで動かす。
    //    正解ずみのマスは disabled でフォーカスを受けない。となりのマスへ 1 つだけ
    //    動かす形だと、枠だけがそこへ移ってフォーカスは元のマスに残り、
    //    ・何回押しても枠がそのマスから先へ進まない（飛ばしたマスへ戻れない）
    //    ・打った数字が、枠とは別のマスに入る
    //    という食い違いが起きていた（実測 2026-11-15）。
    if (e.key === 'Enter') {
      advanceByUser();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault(); advanceByUser();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const colsN = tableData.cols.length;
      for (let idx = r * colsN + c - 1; idx >= 0; idx--) {
        const prevR = Math.floor(idx / colsN);
        const prevC = idx % colsN;
        if (!isSolvedCell(prevR, prevC)) { focusCell(prevR, prevC); break; }
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      for (let nextR = r + 1; nextR < tableData.rows.length; nextR++) {
        if (!isSolvedCell(nextR, c)) { focusCell(nextR, c); break; }
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      for (let prevR = r - 1; prevR >= 0; prevR--) {
        if (!isSolvedCell(prevR, c)) { focusCell(prevR, c); break; }
      }
    }
  }, [advanceByUser, tableData, settings.numpad, settings.handwriting, handleInputChange, isSolvedCell, focusCell]);

  // 「丸つけ する」ボタン（すぐ判定オフのときだけ出る）。
  //
  // ⚠️ すぐ判定オフの終わり方は「全部のマスに、答えの桁数ぶん入ったとき」だけだった。
  //    最後に入れた答えが正解より桁の少ない数だと、全部うまっても採点が始まらない。
  //    キーボードなら Enter、テンキーなら「次へ」で採点できるが、手書きだけの
  //    タブレットにはどちらも無く、「のこり 0問」のまま終われなかった（実測 2026-11-15）。
  //    いつでも押せるボタンを置く。空いているマスがあるときは、押しまちがいで
  //    終わってしまわないように一度たずねる。
  const gradeNow = useCallback(() => {
    setShowGradeConfirm(false);
    if (gameState !== 'playing' || settings.autoScore) return;
    stopGame(countAnswers(inputsRef.current).correct);
  }, [gameState, settings.autoScore, stopGame, countAnswers]);

  const requestGrading = useCallback(() => {
    if (gameState !== 'playing' || settings.autoScore) return;
    // 書きかけの手書きがあれば、先に読み取ってから数える
    flushHandwriting();
    if (!runningRef.current) return;      // 読み取った答えで、全部そろって終わった
    if (countAnswers(inputsRef.current).answered < count) {
      setShowGradeConfirm(true);
      return;
    }
    gradeNow();
  }, [gameState, settings.autoScore, countAnswers, count, gradeNow, flushHandwriting]);

  // ⏳ 制限時間になったら、そこで終わる。
  //    「2分で何問できるか」という取り組み方のため。全員が同じ時刻に終われるので、
  //    一斉に始める授業で、早く終わった子が待つ・終わらない子が残る、が起きない。
  const timeUp = useCallback(() => {
    if (!runningRef.current) return;
    // 書きかけの手書きがあれば、時間までに書いた答えとして読み取っておく
    flushHandwriting();
    if (!runningRef.current) return;      // 読み取った答えで、全部そろって終わった
    runningRef.current = false;
    setShowQuitConfirm(false);
    setShowGradeConfirm(false);
    const limitSec = activeLimitRef.current;
    // ⚠️ 締める時刻は「制限時間ちょうど」にする。気づいた時刻（タブを隠していると
    //    見はりが遅れる）で締めると、2分の約束が回によって 2分3秒になったりする
    const exactTime = timer.stop(limitSec);
    const { correct } = countAnswers(inputsRef.current);
    setGameState('result');
    setResultScore(correct);
    setTimedOut(true);
    if (settings.sound) playSound('finish');
    saveSession('completed', exactTime, true);

    // 「○分で ○問」を記録に残す。1問も正解していない回は残さない
    if (correct === 0) return;
    const today = new Date().toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    // time も入れておく（古い版の画面は time があるものとして描くので、無いと落ちる）
    const entry = { date: today, at: new Date().toISOString(), time: exactTime, count, limit: limitSec, solved: correct };
    const picked = activeDan.length > 0;
    if (picked) entry.dan = activeDan;
    setRecords((prev) => {
      const modeData = prev[mode];
      const history = [entry, ...modeData.history].slice(0, 20);
      const bestSolved = { ...(modeData.bestSolved || {}) };
      // だんを選んだ回は「さいこう」に入れない（ベストタイムと同じ決まり）
      if (!picked && correct > (bestSolved[limitSec] || 0)) bestSolved[limitSec] = correct;
      return { ...prev, [mode]: { ...modeData, history, bestSolved } };
    });
  }, [mode, count, activeDan, settings.sound, timer.stop, countAnswers, saveSession, flushHandwriting]);

  const timeUpRef = useRef(timeUp);
  useEffect(() => { timeUpRef.current = timeUp; }, [timeUp]);
  useEffect(() => {
    if (gameState !== 'playing' || !activeLimit) return;
    const watch = setInterval(() => {
      if (timer.peek() >= activeLimit) timeUpRef.current();
    }, 100);
    return () => clearInterval(watch);
  }, [gameState, activeLimit, timer.peek]);

  // のこり時間（秒）。0 より小さくはしない
  const remainingSeconds = useCallback(
    () => Math.max(0, activeLimit - timer.peek()),
    [activeLimit, timer.peek]
  );

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
    if (ocrTimerRef.current) {
      clearTimeout(ocrTimerRef.current);
      ocrTimerRef.current = null;
    }

    const pos = getCanvasPos(e, i);
    lastPosRef.current[i] = pos;
    drawOnCanvas(e, i);
  };

  const drawOnCanvas = (e, i) => {
    if (!isDrawingRef.current[i]) return;
    e.preventDefault();
    if (ocrTimerRef.current) {
      clearTimeout(ocrTimerRef.current);
      ocrTimerRef.current = null;
    }

    const canvas = canvasRefs[i].current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pos = getCanvasPos(e, i);

    // 線の太さは canvas の実解像度に対する割合で決める。
    // 固定値にすると、DPR 補正で解像度が変わった端末だけ線が細くなり、
    // 28×28 に縮めたときの字の濃さが変わって認識率が落ちる
    //
    // ⚠️ 割合の元は「幅と高さの短いほう」にすること。幅だけで決めると、欄が横長になる
    //    画面（iPad の縦向き・提示モード・分割画面）で線だけが太くなり、字がつぶれる。
    //    欄の高さは 160px で変わらないのに、幅は画面に合わせて 3 倍近くまで広がるため。
    //    実測（2026-11-15）: 線は Chromebook の横画面で 14.5px、iPad の縦向きで 40.7px。
    //    同じ筆跡 20 字のうち読めたのは 19 字と 9 字。短いほうで決めると 18 字に戻った。
    ctx.lineWidth = Math.max(8, Math.min(canvas.width, canvas.height) * 0.1125);
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
    // ref 経由で常に最新の認識処理を呼ぶ（古い state を掴まないように）。
    // 走ったら予約を空にする（flushHandwriting が「まだ残っているか」を見るため）
    ocrTimerRef.current = setTimeout(() => {
      ocrTimerRef.current = null;
      drawHandlersRef.current.recognizeHandwriting();
    }, 400);
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
    <div className="app-shell bg-slate-100/50 text-slate-800 flex flex-col items-center" data-game-state={gameState}>
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
            {/* だんを選んでいるときは、選んだ数より多い行を作れない（同じ行を 2 つ出さない） */}
            {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(n => (
              <option key={n} value={n} disabled={n > maxCount(mode, activeDan)}>{n}問</option>
            ))}
          </select>

          {/* 🔢 だんを選ぶ（かけ算のときだけ出る） */}
          {mode === 'かけ算' && (
            <button onClick={openDan} disabled={gameState === 'playing'} data-testid="dan-button" aria-label={`れんしゅうするだんをえらぶ（いまは ${activeDan.length ? `${activeDan.join('・')}のだん` : 'ぜんぶ'}）`} className="tap-44 min-h-[44px] bg-white border border-slate-300 rounded-lg px-2 py-1 text-sm font-bold text-slate-700 hover:bg-slate-50 whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed">
              <span>{danLabel(activeDan)}</span>
            </button>
          )}

          {/* ⏱ タイム。60 秒以上は「2分5.3秒」の形で出す。
              「タイマーを かくす」設定のときは、とりくんでいる間は出さない
              （時間が気になってあせる子のため）。終わったあとのタイムは出す */}
          {(!settings.hideTimer || gameState === 'result') && (
            // ⚠️ 幅は、いちばん長い表示のぶんを先に取っておく（min-w）。
            //    字数がふえた瞬間（59.9秒 → 1分0.0秒、のこり 2分0秒 → 1分59秒）に幅が広がると、
            //    画面の幅によってはヘッダーが折り返し、とりくんでいる最中にマスの表が下へ動く
            <div className={`text-xl font-bold text-slate-700 flex items-center gap-1 justify-end ${((gameState === 'playing' && activeLimit > 0) || (gameState === 'idle' && settings.timeLimit > 0)) ? 'min-w-[8.5rem]' : 'min-w-[7.5rem]'}`} data-testid="clock">
              <Clock className="w-4 h-4 text-slate-500" aria-hidden="true" />
              {/* 制限時間つきの回は、のこり時間を数える。はじめる前は、決めてある時間を出す */}
              {((gameState === 'playing' && activeLimit > 0) || (gameState === 'idle' && settings.timeLimit > 0)) && (
                <span className="text-xs text-slate-500 font-bold">のこり</span>
              )}
              <span className={gameState === 'playing' ? 'text-blue-600' : ''}>
                {gameState === 'playing' && activeLimit > 0 && (
                  <RunningClock getSeconds={remainingSeconds} whole unitClassName={CLOCK_UNIT_CLASS} />
                )}
                {gameState === 'playing' && !activeLimit && (
                  <RunningClock getSeconds={timer.peek} unitClassName={CLOCK_UNIT_CLASS} />
                )}
                {gameState === 'idle' && (settings.timeLimit > 0
                  ? <TimeText sec={settings.timeLimit} whole compact unitClassName={CLOCK_UNIT_CLASS} />
                  : <TimeText sec={0} unitClassName={CLOCK_UNIT_CLASS} />)}
                {gameState === 'result' && (
                  <TimeText sec={timer.finalTime} unitClassName={CLOCK_UNIT_CLASS} />
                )}
              </span>
            </div>
          )}

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
            <button onClick={() => generateTable(mode, count, dan)} className="tap-44 btn-press bg-blue-600 text-white font-bold py-1.5 px-4 rounded-xl shadow-sm flex items-center gap-1.5 hover:bg-blue-700 text-sm whitespace-nowrap">
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
                {timedOut
                  ? <Hourglass className="w-6 h-6 text-slate-500" aria-hidden="true" />
                  : <Trophy className="w-6 h-6 text-slate-500" aria-hidden="true" />}
                {timedOut ? (
                  <span><ruby>時間<rp>(</rp><rt>じかん</rt><rp>)</rp></ruby>です！よく<ruby>頑張<rp>(</rp><rt>がんば</rt><rp>)</rp></ruby>ったね！</span>
                ) : resultScore === count ? (
                  <span>クリア！よく<ruby>頑張<rp>(</rp><rt>がんば</rt><rp>)</rp></ruby>ったね！</span>
                ) : (
                  <span>おわり！<ruby>正解<rp>(</rp><rt>せいかい</rt><rp>)</rp></ruby> {resultScore} / {count}<ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby></span>
                )}
              </h2>
              {timedOut ? (
                // 時間になって終わった回は、タイムではなく「○分で ○問」を出す
                <p className="text-2xl font-bold text-slate-800 mt-1" data-testid="result-timeup">
                  <TimeText sec={activeLimit} whole compact /> で <span className="text-blue-600 tabular-nums">{resultScore}</span><ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby> できました
                </p>
              ) : (
                <p className="text-2xl font-bold text-slate-800 mt-1">
                  タイム: <span className="text-blue-600" data-testid="result-time"><TimeText sec={timer.finalTime} unitClassName="text-slate-800 mx-0.5" /></span>
                </p>
              )}
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

          {/* ✔ 丸つけ（すぐ判定オフのときだけ）。
              全部うまったら自動で採点が始まるが、桁の足りない答えが最後に入ると
              始まらない。空いているマスを残して終えたいときにも使う */}
          {gameState === 'playing' && !settings.autoScore && (
            <button onMouseDown={(e) => e.preventDefault()} onClick={requestGrading} className="btn-press w-full min-h-[48px] bg-slate-700 hover:bg-slate-800 text-white font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 px-4 py-2">
              <CheckCircle className="w-5 h-5" aria-hidden="true" /> <span><ruby>丸<rp>(</rp><rt>まる</rt><rp>)</rp></ruby>つけ する</span>
            </button>
          )}

          {/* 🖌️ 手書き入力エリア */}
          {settings.handwriting && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-sm font-bold text-slate-600 flex items-center gap-1">
                  <PenTool className="w-4 h-4" aria-hidden="true" /> <span><ruby>手書<rp>(</rp><rt>てが</rt><rp>)</rp></ruby>き<ruby>入力<rp>(</rp><rt>にゅうりょく</rt><rp>)</rp></ruby></span>
                </h2>
                <div className="flex items-center gap-2">
                  <button onMouseDown={(e) => e.preventDefault()} onClick={clearAllCanvas} className="tap-44 btn-press text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 px-3 py-1.5 rounded-full flex items-center gap-1 font-bold" aria-label="手書きした数字を消す">
                    <Eraser className="w-4 h-4" aria-hidden="true" /> <span><ruby>消<rp>(</rp><rt>け</rt><rp>)</rp></ruby>す</span>
                  </button>
                  {/* 手書きだけの端末（タブレット）には Enter もテンキーの「次へ」も無い。
                      ここに無いと、マスを飛ばすことも、すぐ判定オフで次のマスへ進むことも、
                      マスを指で押すしかなくなる */}
                  {gameState === 'playing' && (
                    <button onMouseDown={(e) => e.preventDefault()} onClick={advanceByUser} className="tap-44 btn-press text-xs bg-slate-200 hover:bg-slate-300 text-slate-700 px-3 py-1.5 rounded-full flex items-center gap-1 font-bold" aria-label="つぎのマスへすすむ">
                      <span><ruby>次<rp>(</rp><rt>つぎ</rt><rp>)</rp></ruby>へ</span> <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
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
                <button onMouseDown={(e) => e.preventDefault()} onClick={advanceByUser} className="btn-press h-16 bg-slate-200 hover:bg-slate-300 border-2 border-slate-300 rounded-xl text-slate-700 font-bold flex justify-center items-center shadow-sm text-lg">
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

            ⚠️ data-links を書かないこと。既定の並び（つかいかた・利用規約・
               プライバシー）が出る。docs/manual/manual.md を書いた 2026-08-31 に
               data-links="terms,privacy" を外した。それまでは docs/manual/ が
               無く、「つかいかた」が行き止まりのリンクになっていた。 */}
        <span data-giga-links />
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

      {/* ✔ 丸つけの確かめ（空いているマスが残っているときだけ出る） */}
      {showGradeConfirm && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div ref={gradeBoxRef} role="dialog" aria-modal="true" aria-labelledby="grade-title" tabIndex={-1} className="bg-white rounded-2xl shadow-xl w-full max-w-xs overflow-hidden animate-[fadeIn_0.2s_ease-out]">
            <div className="p-5 text-center">
              <div id="grade-title" className="font-bold text-lg text-slate-700 mb-1"><span><ruby>丸<rp>(</rp><rt>まる</rt><rp>)</rp></ruby>つけ しますか？</span></div>
              <div className="text-xs text-slate-600"><span>まだ {count - solvedCount}マス あいています</span></div>
            </div>
            <div className="p-4 pt-0 flex gap-2">
              <button onClick={() => setShowGradeConfirm(false)} className="flex-1 btn-press bg-slate-700 text-white font-bold py-3 rounded-xl hover:bg-slate-800"><span>つづける</span></button>
              <button onClick={gradeNow} className="flex-1 btn-press bg-white border-2 border-slate-300 text-slate-600 font-bold py-3 rounded-xl hover:bg-slate-50"><span><ruby>丸<rp>(</rp><rt>まる</rt><rp>)</rp></ruby>つけ する</span></button>
            </div>
          </div>
        </div>
      )}

      {/* 🔢 だんを選ぶ画面（かけ算のときだけ開ける） */}
      {showDan && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div ref={danBoxRef} role="dialog" aria-modal="true" aria-labelledby="dan-title" tabIndex={-1} className="modal-shell bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden animate-[fadeIn_0.2s_ease-out] flex flex-col">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center shrink-0">
              <h2 id="dan-title" className="font-bold text-slate-700 flex items-center gap-2"><Grid3x3 className="w-5 h-5 text-slate-600" aria-hidden="true" /> <span>だんを えらぶ</span></h2>
              <button onClick={() => setShowDan(false)} className="tap-44 text-slate-500 hover:text-slate-700" aria-label="えらばずにとじる"><X className="w-6 h-6" aria-hidden="true" /></button>
            </div>
            <div className="scroll-area p-4 overflow-y-auto">
              <p className="text-sm text-slate-600 mb-3 leading-relaxed"><span><ruby>練習<rp>(</rp><rt>れんしゅう</rt><rp>)</rp></ruby>する だんを おして えらびます。<ruby>何<rp>(</rp><rt>なに</rt><rp>)</rp></ruby>も えらばなければ、ぜんぶの だんから <ruby>出<rp>(</rp><rt>で</rt><rp>)</rp></ruby>ます。</span></p>
              {/* 選んだものは、色だけでなく ✓ のしるしでも分かるようにする（§2-8） */}
              <div className="grid grid-cols-2 gap-2">
                {rowPool('かけ算').map((n) => {
                  const on = danDraft.includes(n);
                  return (
                    <button key={n} onClick={() => toggleDanDraft(n)} aria-pressed={on} className={`btn-press min-h-[48px] rounded-xl border-2 font-bold text-lg flex items-center justify-center gap-1.5 ${on ? 'bg-blue-600 border-blue-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
                      {on && <Check className="w-5 h-5" aria-hidden="true" />}
                      <span>{n}のだん</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="p-4 pt-3 shrink-0 border-t border-slate-100 flex gap-2">
              <button onClick={() => setDanDraft(NO_DAN)} disabled={danDraft.length === 0} className="flex-1 btn-press bg-white border-2 border-slate-300 text-slate-600 font-bold py-3 rounded-xl hover:bg-slate-50 disabled:opacity-50"><span>ぜんぶ はずす</span></button>
              <button onClick={applyDan} className="flex-1 btn-press bg-slate-700 text-white font-bold py-3 rounded-xl hover:bg-slate-800"><span>きめる</span></button>
            </div>
          </div>
        </div>
      )}

      {/* ⚙️ 設定モーダル */}
      {showSettings && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          {/* ⚠️ modal-shell（高さの上限）と、中身のスクロールを外さないこと。
              設定の行が増えると、高さの低い画面（スマホ・横向き）では下の行と
              「閉じる」が画面の外に出て、押せなくなる */}
          <div ref={settingsBoxRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} className="modal-shell bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden animate-[fadeIn_0.2s_ease-out] flex flex-col">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center shrink-0">
              <h2 id="settings-title" className="font-bold text-slate-700 flex items-center gap-2"><Settings className="w-5 h-5 text-slate-600" aria-hidden="true" /> <span><ruby>設定<rp>(</rp><rt>せってい</rt><rp>)</rp></ruby></span></h2>
              <button onClick={() => setShowSettings(false)} className="tap-44 text-slate-500 hover:text-slate-700" aria-label="設定をとじる"><X className="w-6 h-6" aria-hidden="true" /></button>
            </div>
            <div className="scroll-area p-4 flex flex-col gap-4 overflow-y-auto">
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

              <label className="flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors">
                <div className="flex items-center gap-3">
                  <Hourglass className="w-5 h-5 text-blue-600 shrink-0" />
                  <div>
                    <div className="font-bold text-slate-700"><span><ruby>時間<rp>(</rp><rt>じかん</rt><rp>)</rp></ruby>を<ruby>決<rp>(</rp><rt>き</rt><rp>)</rp></ruby>める</span></div>
                    <div className="text-xs text-slate-600"><span><ruby>時間<rp>(</rp><rt>じかん</rt><rp>)</rp></ruby>になったら<ruby>終<rp>(</rp><rt>お</rt><rp>)</rp></ruby>わります</span></div>
                  </div>
                </div>
                {/* とりくんでいる間は変えられない（この回の約束は、スタートのときに決まる） */}
                <select
                  aria-label="制限時間"
                  value={settings.timeLimit || 0}
                  disabled={gameState === 'playing'}
                  onChange={(e) => setSettings({ ...settings, timeLimit: parseInt(e.target.value, 10) || 0 })}
                  className="tap-44 bg-white border border-slate-300 rounded-lg px-2 py-1 text-sm font-bold text-slate-700 outline-none focus:border-slate-500 cursor-pointer"
                >
                  {TIME_LIMITS.map((limit) => (
                    <option key={limit} value={limit}>{limit === 0 ? 'なし' : limitLabel(limit)}</option>
                  ))}
                </select>
              </label>

              <label className="flex items-center justify-between p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                <div className="flex items-center gap-3">
                  <EyeOff className="w-5 h-5 text-blue-600" />
                  <div>
                    <div className="font-bold text-slate-700"><span>タイマーを かくす</span></div>
                    <div className="text-xs text-slate-600"><span><ruby>計算<rp>(</rp><rt>けいさん</rt><rp>)</rp></ruby>の<ruby>間<rp>(</rp><rt>あいだ</rt><rp>)</rp></ruby>は<ruby>時間<rp>(</rp><rt>じかん</rt><rp>)</rp></ruby>を<ruby>出<rp>(</rp><rt>だ</rt><rp>)</rp></ruby>しません</span></div>
                  </div>
                </div>
                <input type="checkbox" checked={!!settings.hideTimer} onChange={(e) => setSettings({ ...settings, hideTimer: e.target.checked })} className="w-5 h-5 accent-slate-600 cursor-pointer" />
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
            <div className="p-4 pt-3 shrink-0 border-t border-slate-100">
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
                          <span className="font-bold text-blue-600"><TimeText sec={records[calcMode].best[c]} /></span>
                        </div>
                      ))}
                      {Object.keys(records[calcMode].best).length === 0 && <span className="text-sm text-slate-500"><span>まだ<ruby>記録<rp>(</rp><rt>きろく</rt><rp>)</rp></ruby>がありません</span></span>}
                    </div>

                    {/* ⏳ 制限時間つきでとりくんだときの、いちばん多く正解できた数 */}
                    {TIME_LIMITS.some((limit) => limit > 0 && records[calcMode].bestSolved?.[limit]) && (
                      <>
                        <div className="text-xs font-bold text-slate-500 flex items-center gap-1 mt-3 mb-2"><Hourglass className="w-4 h-4" aria-hidden="true" /> <span><ruby>時間<rp>(</rp><rt>じかん</rt><rp>)</rp></ruby>を<ruby>決<rp>(</rp><rt>き</rt><rp>)</rp></ruby>めたときの さいこう</span></div>
                        <div className="flex gap-4 flex-wrap">
                          {TIME_LIMITS.filter((limit) => limit > 0 && records[calcMode].bestSolved?.[limit]).map((limit) => (
                            <div key={`solved-${limit}`} className="bg-white px-2 py-1 rounded shadow-sm text-sm border border-slate-200">
                              <span className="text-slate-500 text-xs mr-1"><TimeText sec={limit} whole compact />:</span>
                              <span className="font-bold text-blue-600 tabular-nums">{records[calcMode].bestSolved[limit]}<ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby></span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
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
                            {Array.isArray(hist.dan) && hist.dan.length > 0 && (
                              <span className="bg-blue-100 text-blue-900 px-2 py-0.5 rounded text-xs mr-1"><span>{hist.dan.join('・')}のだん</span></span>
                            )}
                            {hist.limit > 0 ? (
                              // 時間になって終わった回は「2分で 64問」
                              <>
                                <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded text-xs mr-2"><span><TimeText sec={hist.limit} whole compact />で</span></span>
                                <span className="font-bold text-slate-700 tabular-nums"><span>{hist.solved}<ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby></span></span>
                              </>
                            ) : (
                              <>
                                <span className="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs mr-2"><span>{hist.count}<ruby>問<rp>(</rp><rt>もん</rt><rp>)</rp></ruby></span></span>
                                <span className="font-bold text-slate-700"><TimeText sec={hist.time} /></span>
                              </>
                            )}
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
