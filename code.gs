/**
 * WebアプリのURLにアクセスされた時に、ゲーム画面（index.html）を表示するための関数です。
 * この関数はGoogle Apps ScriptでWebアプリを作るときのお決まりの形です。
 * @param {Object} e - Webアプリにアクセスがあったときの情報が入っていますが、今回は使いません。
 * @return {HtmlService.HtmlOutput} - 表示するHTMLページを返します。
 */
function doGet(e) {
  // 'index.html'という名前のHTMLファイルを読み込んで、Webページとして表示する準備をします。
  return HtmlService.createHtmlOutputFromFile('index')
    // ブラウザのタブに表示されるタイトルを設定します。
    .setTitle("わくわく！100マス計算チャレンジ")
    // セキュリティに関する設定です。この設定により、他のWebサイトに埋め込んでも動作しやすくなります。
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * ★ ゲームの結果をスプレッドシートに記録するための関数です。
 * HTML側のJavaScriptから 'google.script.run' を通じて呼び出されます。
 * @param {Object} data - ゲーム画面から送られてくるデータです。(タイムスタンプ、計算モード、問題数、点数、タイム)
 * @return {String} - 処理が成功したか失敗したかを示すメッセージを返します。("Success" または エラーメッセージ)
 */
function recordResult(data) {
  // ★★★ 追加点 ★★★
  // 複数人が同時に記録しようとした時に、データが混ざったり壊れたりするのを防ぐための仕組みです。
  // これにより、一度に一人ずつしか書き込み処理が行われなくなります。
  const lock = LockService.getScriptLock();
  try {
    // 5秒間、他の人が処理を終えるのを待ちます。もし30秒経っても終わらなければエラーとします。
    lock.waitLock(5000);

    // --- ここからが実際の記録処理です ---

    // 現在開いているスプレッドシートを取得します。
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // 記録を残したいシートの名前を指定します。
    const sheetName = "100マス計算記録";
    // 指定した名前のシートを取得します。
    const sheet = ss.getSheetByName(sheetName);

    // もし指定した名前のシートが見つからなかった場合のエラー処理です。
    if (!sheet) {
      const errorMessage = "エラー: '" + sheetName + "' という名前のシートが見つかりません。";
      Logger.log(errorMessage); // ログにエラーを記録します。
      return errorMessage; // ゲーム画面にエラーメッセージを返します。
    }

    // ★★★ メールアドレスの取得について ★★★
    // この機能を使うには、Webアプリをデプロイ（公開）する際に、
    // 「次のユーザーとしてアプリケーションを実行:」を『ウェブアプリにアクセスしているユーザー』に設定する必要があります。
    // そうしないと、メールアドレスが正しく取得できません。
    let email = '';
    try {
      // 現在アプリを使っているユーザーのメールアドレスを取得します。
      email = Session.getActiveUser().getEmail();
    } catch (error) {
      // うまく取得できなかった場合は、ログに記録しておきます。
      Logger.log("メールアドレスの取得に失敗しました: " + error);
      email = '不明 (権限エラーの可能性)';
    }
    // メールアドレスが空の場合の表示を設定します。
    if (!email) {
      email = '不明 (ログインしていないユーザー)';
    }

    // ゲーム画面から送られてきたデータを、スプレッドシートに書き込む形に整えます。
    const timestamp = new Date(); // ★変更点: サーバー側で正確な日時を取得します。
    const calculationType = data.operation || '不明';
    const questions = data.questions || '不明';
    const score = data.score !== undefined ? data.score : '不明';
    const time = data.time || '不明';

    // スプレッドシートの最後の行に、新しい記録を1行追加します。
    // [タイムスタンプ(A), メールアドレス(B), 計算モード(C), 問題数(D), 点数(E), タイム(F)] の順番です。
    sheet.appendRow([timestamp, email, calculationType, questions, score, time]);

    Logger.log(email + " さんの記録を追加しました。"); // 処理が成功したことをログに残します。
    return "Success"; // ゲーム画面に「成功」のメッセージを返します。

  } catch (error) {
    // もし記録処理の途中で何かエラーが起きたら、その内容をログに記録します。
    const errorMessage = "記録処理中にエラーが発生しました: " + error.message;
    Logger.log(errorMessage);
    // ゲーム画面にエラーが起きたことを伝えます。
    return errorMessage;
  } finally {
    // ★★★ 追加点 ★★★
    // 処理が終わったら（成功しても失敗しても）、必ずロックを解除して、次の人が処理できるようにします。
    lock.releaseLock();
  }
}
