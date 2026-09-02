#!/usr/bin/env node
/**
 * 【正本】standards/lib/check-secrets.mjs — 秘密の直書きを見つける
 * 各リポジトリへは tools/check-secrets.mjs としてコピーする（中身は変えない）。
 * 走査する場所は secret-scan.config.json に置く。
 *
 *   node tools/check-secrets.mjs
 *
 * なぜ別立てにしたか:
 *   秘密の検出はどのリポジトリのゲートにも入っている「はず」だった。
 *   ところが 2026-08-22 に測ったところ、5本のリポジトリで
 *   **出荷するディレクトリすべてに Google API キーと同じ形の文字列を置いても
 *   ゲートが緑になった**（reversi / quarto / online-100square-calculation /
 *   quoridor / app_launcher）。
 *
 *   reversi にいたっては、ゲート自身がこう言いながら通していた:
 *
 *     ・CANONICAL_MISSING: scripts/lib/project-quality.mjs が未取得。
 *       Part I の検査のみを実行している。
 *     指摘 0件。
 *
 *   「共有の正本があれば足す、無ければ注記して素通り」という作りだったため、
 *   一度も取得されないまま「指摘 0件」を出しつづけていた。
 *   **在るかどうかで挙動が変わる検査は、無いときに黙ってはいけない。**
 *   だからこれは、丸ごと1ファイルで完結し、走らなければコマンドごと失敗する形にした。
 *
 * secret-scan.config.json（リポジトリ直下、無ければ既定値）:
 *   {
 *     "scan": ["src", "public", "js", "css", "index.html"],
 *     "ignore": ["node_modules", "dist", ".git", "coverage", "vendor"],
 *     "allow": [
 *       { "file": "docs/example.md", "reason": "手順書に出てくる見本。実在しない（2026-08-22）" }
 *     ]
 *   }
 *
 *   scan にはディレクトリでもファイルでも書ける。ディレクトリは下まで見る。
 *   allow は「見つかっても通す」ための逃げ道だが、**理由を必ず書く**。
 *   理由の無い allow は、それ自体を失敗として扱う。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULTS = {
  scan: ['src', 'public', 'js', 'css', 'index.html'],
  ignore: ['node_modules', 'dist', 'build', 'out', 'coverage', '.git', 'vendor'],
  allow: [],
};

/** 中身を見る拡張子。画像やフォントに秘密は書けない。 */
const SCANNED_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.gs',
  '.html', '.htm', '.css', '.json', '.yml', '.yaml', '.md', '.txt', '.webmanifest',
]);

/**
 * 秘密の形。
 *
 * ⚠️ ここに足すときは、必ず「その形をした文字列を実際に置いて捕まること」を
 *    確かめること。2026-08-22 に、確認のつもりで
 *      const k = 'AIza' + 'ZZZ…';
 *    と書いたせいで正規表現に当たらず、「正本の検査が見落とした」と
 *    まちがった報告をしたことがある。つなげずに書くこと。
 */
export const PATTERNS = [
  ['GOOGLE_API_KEY', /AIza[0-9A-Za-z_-]{35}/g, 'Google API キー'],
  ['GITHUB_TOKEN', /(?:ghp|gho|ghs|github_pat)_[0-9A-Za-z_]{20,}/g, 'GitHub のトークン'],
  ['OPENAI_API_KEY', /\bsk-[0-9A-Za-z_-]{32,}/g, 'OpenAI の API キー'],
  ['SLACK_TOKEN', /xox[abposr]-[0-9A-Za-z-]{10,}/g, 'Slack のトークン'],
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, '秘密鍵そのもの'],
];

/** 何行目か。人が開いて直せるように行番号で言う。 */
export function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** 1ファイルぶんの中身から、秘密らしき文字列を拾う。 */
export function findSecrets(source) {
  const found = [];
  for (const [id, pattern, label] of PATTERNS) {
    // matchAll は正規表現を複製してから回すので、module 直下で共有している
    // PATTERNS の lastIndex は動かない。作り直す必要はない
    // （2026-08-22、作り直す形と共有する形の両方で測って確かめた）。
    for (const m of source.matchAll(pattern)) {
      found.push({ id, label, line: lineNumberAt(source, m.index ?? 0) });
    }
  }
  return found;
}

/** scan に書かれた場所を、実在するファイルの一覧にひらく。 */
export function filesToScan(root, config, exists = fs.existsSync, stat = fs.statSync, readdir = fs.readdirSync) {
  const ignore = new Set(config.ignore);
  const out = [];
  const walk = (rel) => {
    // ignore は scan に直に書かれた場所にも効かせる。ここを下の階層だけに
    // していると、scan に "dist" と書いたときだけ生成物を読みに行き、
    // 設定の見た目と挙動が食い違う。
    if (ignore.has(path.posix.basename(rel))) return;
    const abs = path.join(root, rel);
    if (!exists(abs)) return;
    if (stat(abs).isDirectory()) {
      for (const name of readdir(abs).sort()) walk(path.posix.join(rel, name));
      return;
    }
    if (SCANNED_EXT.has(path.extname(rel).toLowerCase())) out.push(rel);
  };
  for (const entry of config.scan) walk(entry);
  return out;
}

/** allow に書いてあって、かつ理由が添えてあるファイルか。 */
export function isAllowed(rel, allow) {
  return allow.some((a) => a.file === rel && typeof a.reason === 'string' && a.reason.trim() !== '');
}

/** 理由の無い allow。逃げ道を黙って広げられないよう、これ自体を失敗にする。 */
export function allowWithoutReason(allow) {
  return allow.filter((a) => typeof a.reason !== 'string' || a.reason.trim() === '').map((a) => a.file);
}

export function run(root, config) {
  const problems = [];
  for (const file of allowWithoutReason(config.allow)) {
    problems.push(`allow に理由がありません: ${file}（なぜ通してよいのかを reason に書いてください）`);
  }
  for (const rel of filesToScan(root, config)) {
    if (isAllowed(rel, config.allow)) continue;
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const hit of findSecrets(source)) {
      problems.push(`${rel}:${hit.line} ${hit.label}（${hit.id}）`);
    }
  }
  return problems;
}

function main() {
  const root = process.cwd();
  const cfgPath = path.join(root, 'secret-scan.config.json');
  const config = fs.existsSync(cfgPath)
    ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }
    : DEFAULTS;

  const scanned = filesToScan(root, config);
  // 「0件でした」だけでは、きれいなのか何も見ていないのか区別できない。
  // 走査対象が1つも無いのは設定の誤りなので、緑を返さず落とす。
  if (scanned.length === 0) {
    console.error('❌ 走査するファイルが1つもありませんでした。');
    console.error('   secret-scan.config.json の scan を確かめてください（既定は src / public / js / css / index.html）。');
    process.exit(1);
  }

  const problems = run(root, config);
  if (problems.length > 0) {
    console.error('❌ 秘密の直書きが見つかりました:');
    for (const p of problems) console.error('  - ' + p);
    console.error('\n公開リポジトリなので、履歴に入った時点で漏れたものとして扱ってください。');
    console.error('鍵を無効にして作り直したうえで、コードから外してください。');
    process.exit(1);
  }
  console.log(`秘密の直書きはありません（${scanned.length} ファイルを見ました）`);
}

/* ⚠️ `file://${process.argv[1]}` を文字列で組み立てて比べないこと。Windows は
   file:///C:/… とスラッシュの数が違い、空白や日本語を含むパスは Linux でも
   %20 の有無で一致しない。一致しなければ main() は呼ばれず、何も見ないまま
   exit 0 になる（2026-08-28 に giga-reviewer で起きた型。2026-09-02 に正本 3 本で再発）。
   standards/lib/cli-entry.test.mjs が字面で見張っている。 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
