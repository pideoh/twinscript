# realtime-translate

会議向けリアルタイム文字起こし＋双方向翻訳の静的 Web アプリ（PWA）。ビルドなし・サーバーなし。
ブラウザが Gemini API に直接つなぐ。使い方と料金は README.md。

## 構成（探索せずここを見る）

| ファイル | 役割 |
| --- | --- |
| `src/app.js` | 画面、設定、セッション開始/停止、途中経過・確定文の翻訳制御 |
| `src/segmenter.js` | 認識結果（途中経過/確定）を表示用の文単位に区切る。DOM 非依存 |
| `src/transcriber.js` | Gemini Live API (`gemini-3.5-transcribe-live`) の WebSocket、再接続、10分制限前の接続切り替え |
| `src/translator.js` | `gemini-3.5-flash-lite` でのストリーミング翻訳 |
| `src/audio.js`, `src/pcm-worklet.js` | マイク/タブ音声の取り込み、16kHz PCM 100ms チャンク化 |
| `src/mock.js` | `?mock=1` デモ用ダミー |
| `test/*.test.js` | 単体テスト（node:test、依存なし） |
| `test/e2e/app.e2e.js` | Chrome＋偽マイク＋模擬エンドポイントの通しテスト |

## コマンド

- `npm test` — 単体テスト。ロジック変更後は必ず実行
- `npm run test:e2e` — `src/app.js`・`src/audio.js`・HTML/CSS を触ったときだけ
- `npm start` — http://localhost:5173 （`?mock=1` でキーなしデモ、`?debug=1` で認識結果の生ログ）

## 作業ルール

- 挙動を変えたらテストを同じコミットで追加・更新する。区切りの不具合は `test/segmenter.test.js` に再現ケースを足してから直す
- 依存パッケージを増やさない（実行時依存ゼロ、devDependency は `playwright-core` のみ）
- 実 API では未検証の前提がある（途中経過は発話全体の累積、確定は発話の切れ目で1回）。API の仕様に関わる変更は推測で書かず公式ドキュメントを確認する
- マージ済みブランチに積まない。`main` から新しいブランチを切って PR を出す
- UI 文言は日本語、コード・コメント・コミットメッセージは英語

## トークン節約

- 上の表で場所が分かるものは検索しない。ファイルは必要な範囲だけ読み、読んだものを読み直さない
- 調査用のサブエージェントや Web 検索は、ここと README に答えがないときだけ使う
- テストは対象を絞って実行し（`node --test test/segmenter.test.js`）、出力は失敗分と集計だけ見る
- `node_modules/`、`package-lock.json`、`icons/*.png` は読まない（settings.json で拒否済み）
- スクリーンショットは見た目を変えたときだけ撮る
- 返答は結論と変更点を短く。経過の説明やコードの再掲はしない
