# dsh-file-transfer

[English](README.md) · [简体中文](README.zh.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH 0.2.0-rc.2 verified](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2%20verified-4dabf7)](https://github.com/deepseek-ai/deepseek-harness)
[![No build step](https://img.shields.io/badge/build-none-brightgreen)](#development)

**DSH Web のサイドバーからファイルをダウンロードし、ワークスペースへファイルを戻せます — localhost だけでなく、リモート接続越しでも。**

DeepSeek Harness にはワークスペースを閲覧・プレビューできるサイドバーのファイルツリーが同梱されていますが、双方向とも読み取り専用です。本プラグインは、欠けていた 2 つの操作を追加します。

| | |
| --- | --- |
| ![右サイドバーのファイルタブ。再読み込みボタンの隣に Upload コントロールがある](docs/screenshot-files.png) | ![プレビュー中のテキストファイル。プレビューヘッダーに Download コントロールがある](docs/screenshot-download.png) |
| ファイルツリーヘッダーの **⬆ Upload** — 選択したファイルをワークスペースへ送り込みます | プレビューヘッダーの **⬇ Download** — 開いているファイルを手元のマシンに保存します |

## なぜ必要か

ハーネスをヘッドレスのマシンで動かし、ブラウザから利用していると、日常的に使うはずの 2 つの操作が欠けています。

- **ファイルを取り出せない。** サイドバーのどこも `Content-Disposition` を設定しないため、プレビューしたレポートや PDF、画像を保存できません。結局ホストに戻り、`scp`、共有ドライブ、USB メモリなどで手作業でコピーすることになります。
- **ファイルを置けない。** ワークスペースのファイルサービスが公開しているのは `list` / `read` / `readBytes` / `stat` / `changes` だけで、書き込み経路がありません。そのため手元のノート PC にあるファイルは、エージェントが触れる前に別の方法でアップロードしておく必要があります。

本プラグインは意図的に小さく、サイドバーの中に留まります。新しいファイルブラウザを作るのではなく、すでに使っているファイルブラウザにダウンロードとアップロードの操作を足すだけです。

## 機能

**⬇ ダウンロード**

- ファイルを streaming で転送します — バイト列がホストメモリ上に 1 つのバッファとして載ることはありません。
- `HEAD` と単一の `Range` に対応しているため、レジュームや事前確認が機能します（`206 Partial Content`）。
- `Content-Disposition: attachment` と RFC 5987 の `filename*` を使うため、CJK や絵文字を含む名前も `%E6%8A%A5...` のような形にならずにそのまま往復できます。
- 拡張子に応じた正しいコンテンツタイプに加えて、`nosniff` と `no-store` を付与します。
- 独自のサイズ上限はありません。

**⬆ アップロード**

- 生バイトをそのままディスクへ streaming します。multipart のエンベロープも base64 もなく、33 % の膨張もありません。
- まず `.dsh-part-*` という兄弟ファイルへ書き、ストリームが完了してから本来の場所へ rename します。そのため、中断されたアップロードが本当のファイル名で切り詰められたファイルを残すことはありません。
- 決して上書きしません。2 つ目の `report.pdf` は `report-1.pdf` になります。
- 任意のサイズ上限（`maxUploadBytes`）を設定でき、大きすぎるボディを拒否して後始末も行います。

**共通**

- 認証は DSH 自身の Connection レイヤーが行います。未認証のリクエストはハンドラが動く前に `401` で拒否されます。CSRF トークンのやり取りも、別途ログインも不要です。
- ルートの許可リスト、`realpath` による解決、symlink 脱出の拒否。
- 使い慣れたエラー形式（`{ ok: false, error: { code, message } }`）と、安定した機械可読なコード。

## インストール

```sh
# from GitHub
dsh plugin --profile web add github:helixzz/dsh-file-transfer

# or from a local checkout
dsh plugin --profile web add /path/to/dsh-file-transfer
```

パッケージは `dsh.bundle.patch` を宣言しているため、`dsh plugin add` がそれをプロファイルの `dsh.profile.bundles` レイヤースタックへ自動的に追加します — `cordis.patch.yml` を手で編集する必要はありません。

その後、プロファイルを再起動するか:

```sh
systemctl --user restart deepseek-harness.service   # or however you run dsh web
```

…あるいは、プロファイルが `patchReload: live` で動いているなら、ローダーが新しいバンドルを拾うのでページを再読み込みするだけで済みます。（このプラグインが作られたマシンでは、まさにこの方法でデプロイされています — 再起動は不要です。）

セッションを開き、右サイドバーを展開して **file** タブを選びます。`⬆ Upload` は再読み込みボタンの隣にあります。任意のファイルを開くと、`⬇ Download` が「open with」コントロールの隣にあります。

## リバースプロキシの背後で使う

アップロードに合ったボディサイズ上限を設定してください。nginx の場合:

```nginx
client_max_body_size 100m;
```

必要なのはこれだけです。ここで認証を担うのはプロキシではありません。ルートは DSH の Connection fetch レジストリに登録されるため、有効なセッションを持たないリクエストはプラグインに到達しません:

```console
$ curl -o /dev/null -w '%{http_code}\n' \
    'http://127.0.0.1:3900/api/dsh-file-transfer/download?path=/etc/hostname'
401
```

## 設定

すべてのオプションは任意です。同梱の patch を編集するのではなく、自分のプロファイルレイヤーで上書きしてください:

```yaml
- id: file-transfer
  config:
    roots: []            # allow-list of absolute roots; [] means unrestricted
    allowUpload: true
    allowOverwrite: false
    maxUploadBytes: 0    # 0 means no limit
```

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `roots` | `[]` | 空でない場合、すべてのダウンロード／アップロード対象は、symlink を含めてこれらのルートのいずれかの内側に解決される必要があります。それ以外は `403 outside-roots` になります。 |
| `allowUpload` | `true` | `false` にするとアップロードルート自体が削除されます（`403 upload-disabled`）。 |
| `allowOverwrite` | `false` | オフの場合、既存の名前は決して置き換えられず、代わりに空いている `name-N.ext` が使われます。 |
| `maxUploadBytes` | `0` | これより大きいボディを `413 upload-too-large` で拒否し、部分的なファイルを削除します。 |

## HTTP API

ルートは 2 つで、どちらも `/api/` の下にあり、どちらも認証済みの Connection を必要とします。ターミナル、スクリプト、エージェントから利用できます:

```sh
# download (streams to stdout; add -r 0-1023 for a range)
curl -O -J 'https://host/api/dsh-file-transfer/download?path=/abs/report.pdf'

# upload (raw bytes, no multipart envelope)
curl -X POST -H 'content-type: application/octet-stream' \
  --data-binary @report.pdf \
  'https://host/api/dsh-file-transfer/upload?dir=/abs/dir&name=report.pdf'
```

アップロードが成功すると、次のように応答します:

```json
{ "ok": true, "value": { "path": "/abs/dir/report.pdf", "name": "report.pdf", "bytes": 20481 } }
```

失敗時は、ハーネスの他の部分と同じ形式を使います:

```json
{ "ok": false, "error": { "code": "outside-roots", "message": "path is outside the configured roots" } }
```

| コード | ステータス | 意味 |
| --- | --- | --- |
| `missing-path` | 400 | `path` / `dir` クエリパラメータがありません。 |
| `not-absolute` | 400 | パスが相対パスでした。 |
| `not-a-file` / `not-a-directory` | 400 | エントリの種類が違います。 |
| `invalid-name` | 400 | 指定された名前が、使える形に正規化した結果、何も残りませんでした。 |
| `not-found` | 404 | パスが存在しません。 |
| `outside-roots` | 403 | 設定された `roots` の外側に解決されました。 |
| `upload-disabled` | 403 | `allowUpload: false` です。 |
| `name-exhausted` | 409 | 候補となる名前 10 000 個がすべて使用済みでした。 |
| `upload-too-large` | 413 | ボディが `maxUploadBytes` を超えました。 |
| `write-failed` | 500 | ホストがファイルを書き込めませんでした。 |

## セキュリティモデル

- **認証** は Connection fetch レジストリから提供されます — 同梱の `/api/file` ルートが使っているのと同じ接続点です。匿名で到達できるルートはありません。
- **パス解決** では、ブラウザから渡されたすべてのパスを `realpath` に通すため、`..` セグメントや symlink は `roots` のチェックより *前に* 解決されます。許可されたルートの外を指す symlink は拒否され、これを単体テストで検証しています。
- **ファイル名** は単一のパスセグメントに正規化されます。`../../etc/passwd` は `passwd` になり、選択したディレクトリの内側に収まります。単体テストだけでなく、エンドツーエンドで検証済みです。
- **書き込み** は読み手から見てアトミックです（`.dsh-part-*` に書いてから rename）。明示的に要求しない限り、既存のファイルを壊すことはありません。

本プラグインはハーネスプロセス自身の権限で動作します。`roots` は、ハーネスを共有しているときに公開範囲を狭めるためのつまみであり、`allowUpload: false` は書き込み経路を完全に無効にします。

## 互換性

`@deepseek-ai/dsh` **0.2.0-rc.2** に対してビルド・検証しています。

このパッケージは **意図的に `peerDependencies` を宣言していません**。厳しすぎる peer レンジこそが、本来なら動作するプラグインを DSH のバージョンゲートに拒否させる原因になります:

```console
dsh: installation rejected: Plugin <name> is incompatible with dsh 0.2.0-rc.2:
     peerDependencies {"@deepseek-ai/dsh-client-connection":"^0.1.0"}
```

本プラグインがやり取りするのは `connection` サービスと Node の組み込みモジュールだけです。また、0.2 で削除されたパッケージ（例えば `@deepseek-ai/dsh-client-runtime`）をクライアント側で import することも避けています。クライアント側の依存が欠けていると、ブラウザ側の半分がまったく有効化されなくなるためです。

## 開発

ビルドステップはありません。`lib/index.js`（ESM のホスト側）と `lib/client.js`（Web シェルの `__ModuleLoader__` 向けに手書きした CJS バンドル）が出荷される成果物で、どちらもコミットされているため、`github:` からのインストールが prepare スクリプトなしで動作します。

```sh
node --check lib/index.js && node --check lib/client.js
node --test test/host.test.mjs
```

単体テストは、エクスポートされたハンドラを標準の `Request` オブジェクトで動かします。そのため Range、disposition、名前のサニタイズ、ルートの強制、上書きの挙動、サイズ上限、symlink 脱出が、プロファイルを起動せずにすべて確認できます。ケースは 8 件で、fixture 用のハーネスは不要です。

## ロードマップ

- ディレクトリを単一の ZIP としてダウンロード。
- ツリーが現在表示しているディレクトリへのアップロード（ワークスペースルートだけでなく）、およびドラッグ＆ドロップ。
- 配信ファイルカード上のダウンロードコントロール。現在 `deliverables.file.actions` はファイルシステムのパスではなく内部アクション URL を渡すため、これには上流側の仕組みが要ります。

## コントリビュート

Issue と pull request を歓迎します。送る前に知っておいてほしいことが 2 つあります:

- **テストを実行してください。** `node --test test/host.test.mjs` は green のままである必要があります。
- **翻訳を同期させてください。** README は 6 言語で存在し、どれも同じプラグインを説明するものです。挙動を変えた場合は、自分が書ける翻訳を更新し、その旨を PR で述べてください。残りは後から追従できます。

表面積は小さく保ってください。このプラグインの価値は、DSH 自身のファイルブラウザの上で 2 つのことを予測可能にこなす点にあり、IDE へ育つことではありません。

## ライセンス

MIT
