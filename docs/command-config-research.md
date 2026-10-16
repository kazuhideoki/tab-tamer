# コマンドによる設定反映の調査

この文書は実装前の調査記録。現在の使い方は [README](../README.md)、実装と検証の境界は [implementation.md](implementation.md) を参照。

2026年10月16日。推奨は、反映コマンドの実行中だけloopback HTTPサーバーを起動し、拡張自身の短命な取込ページが設定を受け取る方式。通常利用時にサーバーを残さず、ファイル選択・手動リロードなしで完了応答を得られる。

## 方式比較

| 方式 | 判断 |
| --- | --- |
| CLIでJSON生成、手動リロード | コマンドだけで反映完了する要件に合わない |
| Native Messaging | ブラウザがホストを起動する方式。CLIから拡張を起こす経路を別途用意する必要があり、今回は優先しない |
| 定期ポーリング | 常時ファイル参照を不要とする方針と合わない |
| 通常プロファイルのCDP接続 | リモートデバッグ設定に依存するため、通常の反映経路には採用しない |
| 一時HTTPページから外部メッセージ | 一度成功したが、診断介入なしの可視Braveでタイムアウト。採用を見送る |
| 拡張自身のページから一時HTTPサーバーへ接続 | 今回の推奨。可視Braveで保存とACKを確認し、Brave起動コマンドからのページ起動でも成功 |

[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)は拡張のsendNativeMessage/connectNativeからホストを起動する。ホストをCLIとして起動するだけでは拡張へ通知できない。

[externally_connectable](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)で許可したページから、拡張IDを指定してruntime.sendMessageできる。拡張はonMessageExternalで受け、非同期保存の完了後に応答できる。[メッセージ送受信](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)

## 反映手順案

1. コマンドがconfig.tomlを読み、スキーマ・色・ルール・上限を検証する。不正ならブラウザ操作前に終了する。
2. 127.0.0.1の空きポートに一時サーバーを起動し、期限付きの要求IDと設定ハッシュを発行する。
3. Brave起動コマンドで、対象プロファイルの `chrome-extension://<固定ID>/apply.html` を開く。接続先ポートと要求IDをフラグメントで渡す。通常プロファイルの選択方法は実装時に検証する。
4. 拡張の取込ページが一時サーバーから署名付き設定を取得する。接続先を127.0.0.1と許容ポートに制限し、署名、期限、要求ID、スキーマを検証する。
5. 拡張の処理キュー上で設定を切り替え、storage.localへ保存・読戻しする。処理中の古い設定世代の要求は無効化する。
6. 拡張の取込ページが要求ID・ハッシュ・設定世代・結果をCLIへ返す。CLIは要求との一致と応答の真正性を確認して成功終了する。
7. 一時ページとサーバーを終了する。失敗・タイムアウト時も期限付きで片付け、成功したと推定しない。応答が失われた場合に備え、要求IDで結果を照会できるようにする。

初期導入では拡張IDと共有鍵を設定する。個人用のignoredなビルド成果物へ鍵を含める案があるが、通常のソース管理には含めない。CLI用の鍵ファイルは所有者だけが読める権限とし、転送ページ・URL・ログに鍵を載せない。localhostという接続先だけでは、正規の反映コマンドと他のローカルプロセスを区別できない。署名と再送防止は本実装の必須条件とする。設定全体を署名対象とし、単なるACK受信を成功条件にしない。

コマンド実行時には短命なタブが作られる。完全に画面を変えず反映できるかは未検証。自拡張の重複防止・グループ分けから反映ページを除外する。ユーザーが途中で切り替えた場合、終了時に元タブへ強制的に戻さない。

## 通信実験の結果

[probe-command-transport.mjs](../scripts/research/probe-command-transport.mjs)は、通常のBraveプロファイルと分離した一時プロファイルに、試験用MV3拡張をロードする。以下のコマンドで拡張自身のページをBrave起動コマンドから開き、loopbackから設定取得、storage.localへの保存と読戻し、HTTPによる完了応答まで成功した。

```sh
node scripts/research/probe-command-transport.mjs --visible --extension-page --browser-command
```

```json
{"ok":true,"stored":{"probe":"command-only","schema_version":1}}
```

可視Braveで、CDPから取込ページを開いた試行と、Brave起動コマンドで開いた試行の両方が成功した。試験では拡張IDの発見とブラウザ終了にCDPを使用したが、後者のページ起動・設定転送・保存・応答にCDPのRuntime.evaluate等は使用していない。製品では導入時に固定した拡張IDを使うため、ID発見のデバッグ接続を不要にできる。

試験拡張の権限はstorageとloopbackへのhost_permissions。比較実験用のexternally_connectableもスクリプトには残しているが、推奨方式では不要。今回は取込ページが直接storageへ保存するダミー実験であり、本実装ではservice workerの共通キューを通して動作中の設定を切り替える。

外部ページからonMessageExternalを使う方式は、診断介入のあるheadless試行では成功したが、介入なしの可視Braveではページ送信開始後にACKが返らず30秒でタイムアウトした。原因は未確定であり、推奨方式から外した。

これは認証なしのダミー設定を使った通信経路の実験であり、製品の設定取込機能ではない。TOML検証、認証、通常プロファイルでの起動・タブの片付け、再起動後の読戻しは未検証。通常プロファイルの拡張設定は変更していない。

試験ブラウザとサーバーは停止した。終了直後に見えた試験プロファイルのrenderer 2件も、その後自然終了した。一時プロファイルは診断用にOSの一時ディレクトリへ残す。共有鍵や実際の個人設定は含めない。
