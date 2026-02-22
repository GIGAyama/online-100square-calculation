/**
 * =========================================================================
 * GIGA Standard リファクタリング v2
 * アプリ名: 100マス計算（計算ドリル）
 * ファイル: コード.gs (バックエンド処理)
 * 概要: コンテナバインドスクリプトとして動作し、記録をスプレッドシートに保存します。
 * =========================================================================
 */

/**
 * Webアプリの初期表示を行う関数
 */
function doGet(e) {
  // index.htmlを評価して出力を作成
  var htmlOutput = HtmlService.createTemplateFromFile('index').evaluate();
  
  // ページタイトルと、スマートフォン・タブレット向けのビューポート設定
  htmlOutput.setTitle('100マスけいさん');
  htmlOutput.addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
  
  return htmlOutput;
}

/**
 * HTMLファイル内で別ファイル(CSS, JS)を読み込むための関数
 * @param {string} filename 読み込むファイル名（拡張子なし）
 * @return {string} 読み込んだファイルの内容
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * 計算の記録をスプレッドシートに保存する関数
 * 【要件】スプレッドシートの構成は絶対に変えない
 * （タイムスタンプ, メールアドレス, 計算モード, 問題数, 点数, タイム）
 * * @param {Object} data 記録データ { mode: string, count: number, score: number, time: number }
 * @return {Object} 保存結果 { success: boolean, message: string }
 */
function saveRecord(data) {
  // 排他制御（複数人の児童が同時にクリアした際の書き込み競合を防ぐ）
  var lock = LockService.getScriptLock();
  
  // 30秒間ロックの取得を試行
  if (!lock.tryLock(30000)) {
    return { 
      success: false, 
      message: '現在サーバーが混み合っています。少し待ってから再度お試しください。' 
    };
  }

  try {
    // コンテナバインドされたスプレッドシートを取得
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // 記録用のシート（一番左のシートを想定）を取得
    var sheet = ss.getSheets()[0]; 
    
    // 実行ユーザーのメールアドレスを取得（取得できない場合はゲスト扱い）
    var email = Session.getActiveUser().getEmail() || "guest@example.com";
    
    // 現在の日時を取得（タイムスタンプ用）
    var timestamp = new Date();
    
    // シートが完全に空の場合のみ、念のためヘッダー行を追加（構成の変更ではありません）
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["タイムスタンプ", "メールアドレス", "計算モード", "問題数", "点数", "タイム"]);
      
      // GIGA Standard: 先生が見やすいようにヘッダー行を固定し、背景色を設定
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, 6).setBackground('#f3f3f3').setFontWeight('bold');
    }
    
    // データを既存のCSV構成に合わせて配列化
    // 構成: タイムスタンプ, メールアドレス, 計算モード, 問題数, 点数, タイム
    var rowData = [
      timestamp,
      email,
      data.mode,
      data.count,
      data.score,
      data.time
    ];
    
    // スプレッドシートの最終行にデータを追記
    sheet.appendRow(rowData);
    
    return { success: true, message: '記録が保存されました！' };

  } catch (error) {
    // エラー時のログ記録
    console.error("記録保存エラー: " + error.message);
    return { success: false, message: 'システムエラーが発生しました: ' + error.message };
  } finally {
    // 処理完了後、またはエラー発生時も必ずロックを解除する
    lock.releaseLock();
  }
}

/**
 * =========================================================
 * 拡張機能：Googleドライブからのファイル読み込み（GAS完結用）
 * =========================================================
 */

// ★★★ ここに手順1でメモしたファイルIDを入力してください ★★★
var FILE_IDS = {
  modelJson: '1b8cf-0ifS3ws78Sfobuy8K-S8J7wo4sU',
  modelBin: '1ruyTMhnO-prmFaQD6LRAlF65JXnKaaxt',
  soundCorrect: '1AFR0iKatlvL7U-Pe5PFnXwG_S4P6c07Y',
  soundIncorrect: '1sfBNJQnm6yB04gf4HCQ1UahIAeuUm9R7',
  soundEnd: '17Vi98kiF7tkPfOBpLwTaEBHugFyaKaVg'
};

/**
 * 指定したGoogleドライブのファイルをBase64文字列に変換して返す
 */
function getBase64Data(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    return Utilities.base64Encode(file.getBlob().getBytes());
  } catch(e) {
    console.error("ファイル読み込みエラー (ID: " + fileId + "): " + e.message);
    return null;
  }
}

/**
 * AIモデルのデータを取得する
 */
function loadModelData() {
  try {
    var jsonFile = DriveApp.getFileById(FILE_IDS.modelJson);
    return {
      success: true,
      jsonStr: jsonFile.getBlob().getDataAsString(),
      binBase64: getBase64Data(FILE_IDS.modelBin)
    };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

/**
 * 効果音の音声データを取得する
 */
function loadAudioData() {
  return {
    correct: getBase64Data(FILE_IDS.soundCorrect),
    incorrect: getBase64Data(FILE_IDS.soundIncorrect),
    end: getBase64Data(FILE_IDS.soundEnd)
  };
}
