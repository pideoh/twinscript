# realtime-translate

会議向けリアルタイム文字起こし＋双方向翻訳の静的 Web アプリ（PWA）。ビルドなし・サーバーなし。
ブラウザが Gemini API に直接つなぐ。使い方と料金は README.md。

## 構成（探索せずここを見る）

| ファイル | 役割 |
| --- | --- |
| `src/app.js` | 画面、設定、保存済みセッションの一覧/切替、開始/停止、翻訳制御、ダウンロード |
| `src/segmenter.js` | 認識結果（途中経過/確定）を表示用の文単位に区切る。DOM 非依存 |
| `src/transcriber.js` | Gemini Live API (`gemini-3.5-transcribe-live`) の WebSocket、再接続、10分制限前の接続切り替え |
| `src/translator.js` | `gemini-3.5-flash-lite` でのストリーミング翻訳 |
| `src/audio.js`, `src/pcm-worklet.js` | マイク/タブ音声の取り込み、16kHz PCM 100ms チャンク化、録音用ミックス |
| `src/recorder.js` | MediaRecorder で録音し 5 秒ごとにチャンクを渡す |
| `src/store.js` | IndexedDB。`sessions`（文字起こし込み）と `audio`（録音チャンク） |
| `src/exporter.js` | 文字起こしの書き出し（txt / md / csv / srt）。純粋関数 |
| `src/mock.js` | `?mock=1` デモ用ダミー |
| `app/main.js` | デスクトップ版（Electron）のメインプロセス。`app://rt/` で配信、PC音声、字幕オーバーレイ |
| `app/policy.js` | デスクトップ版の規則（配信するファイル、遷移・window.open・権限の許可）。Electron 非依存 |
| `test/*.test.js` | 単体テスト（node:test、依存なし） |
| `test/e2e/app.e2e.js` | Chrome＋偽マイク＋模擬エンドポイントの通しテスト |
| `test/app/desktop.app.js` | デスクトップ版の起動確認（画面が要るので CI では動かさない） |
| `.github/workflows/desktop.yml` | macOS / Windows の zip を作る（手動実行と `v*` タグ） |

## コマンド

- `npm test` — 単体テスト。ロジック変更後は必ず実行
- `npm run test:e2e` — `src/app.js`・`src/audio.js`・HTML/CSS を触ったときだけ
- `npm start` — http://localhost:5173 （`?mock=1` でキーなしデモ、`?debug=1` で認識結果の生ログ）
- `npm run app` — デスクトップ版を起動。`npm run test:app` は `app/` か字幕ウィンドウを触ったときだけ
- `npm run dist:mac` / `npm run dist:win` — `dist/` に zip を作る

## 作業ルール

- 挙動を変えたらテストを同じコミットで追加・更新する。区切りの不具合は `test/segmenter.test.js` に再現ケースを足してから直す
- 依存パッケージを増やさない（実行時依存ゼロ、devDependency は `playwright-core`・`electron`・`electron-builder` のみ）
- Web 版はブラウザでそのまま動くこと。デスクトップ版専用の処理は `app/` に置き、`src/` では Electron 判定での分岐に留める
- 実 API では未検証の前提がある（途中経過は発話全体の累積、確定は発話の切れ目で1回）。API の仕様に関わる変更は推測で書かず公式ドキュメントを確認する
- マージ済みブランチに積まない。`main` から新しいブランチを切って PR を出す
- UI 文言は日本語、コード・コメント・コミットメッセージは英語

## トークン節約

- 上の表で場所が分かるものは検索しない。ファイルは必要な範囲だけ読み、読んだものを読み直さない
- Web 検索は、ここと README に答えがないときだけ使う
- テストは対象を絞って実行し（`node --test test/segmenter.test.js`）、出力は失敗分と集計だけ見る
- `node_modules/`、`package-lock.json`、`icons/*.png` は読まない（settings.json で拒否済み）
- スクリーンショットは見た目を変えたときだけ撮る
- 返答は結論と変更点を短く。経過の説明やコードの再掲はしない

### モデルの使い分け

メインのセッションは設計・判断・難しい不具合の切り分けに使い、切り出せる作業は安いモデルのサブエージェントに渡す。
`.claude/agents/` に定義済み。

| エージェント | モデル | 渡す作業 |
| --- | --- | --- |
| `implementer` | Opus | 仕様が決まった複数ファイルの実装、リファクタ、差分レビュー |
| `test-writer` | Sonnet | 既存モジュールへのテスト追加、定型的な修正、ドキュメント更新 |
| `runner` | Haiku | テスト実行と失敗の要約、ファイルや記述の検索 |

- 渡すのは、仕様を数行で書き切れて、結果を差分かテストで確かめられる作業だけ
- 1 ファイルの小さな修正は自分でやる（依頼文と結果の受け渡しのほうが高くつく）
- 依頼文には目的・対象ファイル・完了条件を書き、この CLAUDE.md を読ませる。会話の経緯は渡さない
- 独立した作業が複数あるときは 1 回のメッセージで並行に起動する
- ワークフロー（多数エージェントの自動連携）はユーザーが明示的に頼んだときだけ使う
