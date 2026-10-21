# dsh-file-transfer

[English](README.md) · [简体中文](README.zh.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH 0.2.0-rc.2 verified](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2%20verified-4dabf7)](https://github.com/deepseek-ai/deepseek-harness)
[![No build step](https://img.shields.io/badge/build-none-brightgreen)](#development)

**DSH Web の sidebar からファイルをダウンロードし、ファイルを workspace に戻し、フォルダーを丸ごと ZIP にできます — localhost だけでなく、リモート接続越しでも。**

DeepSeek Harness には workspace を閲覧・プレビューできる sidebar のファイルツリーが同梱されていますが、どちらの方向にも読み取り専用です。この plugin は、そこに欠けていた操作を追加します：

| | |
| --- | --- |
| ![右サイドバーのファイルタブ。再読み込みボタンの隣に Upload、対象フォルダー、ZIP のコントロールがある](docs/screenshot-files.png) | ![プレビュー中のテキストファイル。プレビューヘッダーに Download コントロールがある](docs/screenshot-download.png) |
| ファイルツリーヘッダーの **⬆ Upload** と **🗜 ZIP** — 選んだフォルダーへファイルを送り込むか、フォルダーを丸ごと持ち出せます | プレビューヘッダーの **⬇ Download** — 開いているファイルを手元のマシンに保存します |

## なぜ必要か

ヘッドレスのマシンで harness を動かし、ブラウザー経由でアクセスしている場合、日常的に必要になる 2 つのことができません：

- **ファイルを取り出せない。** sidebar のどこも `Content-Disposition` を設定しないため、プレビュー中のレポート、PDF、画像を保存できません。結局ホストに戻って手作業でコピーすることになります — `scp`、共有ドライブ、USB メモリーなど。
- **ファイルを置けない。** workspace のファイルサービスが公開しているのは `list` / `read` / `readBytes` / `stat` / `changes` だけで、それ以外はありません。書き込み経路がないため、ノート PC にあるファイルは、agent が触れるようにする前に別の方法でアップロードしておく必要があります。

この plugin は意図的に小さく、sidebar の中に留まります。新しいファイルブラウザーを作るのではなく、すでに使っているファイルブラウザーにダウンロードとアップロードの操作を追加するだけです。

## 機能

**⬇ ダウンロード**

- ファイルを streaming で返します — バイト列がホストのメモリー上に 1 つのバッファーとして載ることはありません。
- `HEAD` と単一の `Range` に対応しているため、レジュームや事前確認が機能します（`206 Partial Content`）。
- `Content-Disposition: attachment` と RFC 5987 の `filename*` を使うため、CJK や絵文字を含む名前も `%E6%8A%A5...` のような形で届くのではなく、そのまま往復できます。
- 拡張子ごとに正しい content type を返し、さらに `nosniff` と `no-store` を付けます。
- 独自のサイズ上限はありません。

**⬆ アップロード**

- 生のバイト列をそのままディスクへ streaming します。multipart のエンベロープも、base64 も、33 % の膨張もありません。
- まず `.dsh-part-*` という兄弟ファイルへ書き、stream が完了してから本来の場所へ rename します。そのため、中断されたアップロードが本当のファイル名で切り詰められたファイルを残すことはありません。
- 既存のファイルは上書きしません。2 つ目の `report.pdf` は `report-1.pdf` になります。
- 任意のサイズ上限（`maxUploadBytes`）を設定でき、大きすぎるボディーを拒否して後始末も行います。
- **いま見ているフォルダーが対象**になります。workspace のルートだけではありません。フォルダーの行をクリックすると（ファイルの行ならその親を使います）ボタンの対象もそれに追随し、隣のチップには常に宛先が表示されます。
- **ファイルをツリーへ drag-and-drop できます。** フォルダーの行にドロップするとそのフォルダーへ、ファイルの行にドロップするとその親へ、空白部分にドロップするとルートへアップロードします。ドラッグ中はポインター下の行が枠線で強調されます。

**🗜 フォルダーを ZIP 化**

- ワンクリックで選択中のフォルダーを 1 つのアーカイブにします。再帰的で、CJK 名は保持され、空のディレクトリーも残り、symlink はスキップされます。
- streaming しながら deflate するため、アーカイブがホストのメモリー上に 1 つの塊として載ることはありません。
- ZIP 仕様に直接沿って書き出します（data descriptor と UTF-8 名フラグ）。そのため plugin はランタイム依存ゼロのまま提供できます。
- デフォルトで 20 000 ファイルまでに制限され、任意でバイト予算も設定できます。4 GiB を超える単一のエントリーは、ZIP32 では表現できないため拒否されます。

**共通**

- 認証は DSH 自身の Connection レイヤーが行います。未認証のリクエストは、ハンドラーが実行される前に `401` で拒否されます。CSRF トークンの扱いに悩む必要も、別途ログインする必要もありません。
- ルートの許可リスト、`realpath` による解決、symlink 脱出の拒否。
- 使い慣れたエラーエンベロープ（`{ ok: false, error: { code, message } }`）と、安定した機械可読なコード。

## インストール

```sh
# from GitHub
dsh plugin --profile web add github:helixzz/dsh-file-transfer

# or from a local checkout
dsh plugin --profile web add /path/to/dsh-file-transfer
```

このパッケージは `dsh.bundle.patch` を宣言しているため、`dsh plugin add` がそれをプロファイルの `dsh.profile.bundles` レイヤースタックへ自動的に追加します — `cordis.patch.yml` を手で編集する必要はありません。

そのあと、プロファイルを再起動するか：

```sh
systemctl --user restart deepseek-harness.service   # or however you run dsh web
```

…あるいは、プロファイルが `patchReload: live` で動作している場合は、ローダーに新しいバンドルを拾わせて、ページを再読み込みするだけで済みます。（この plugin が書かれたマシンでは、まさにこの方法でデプロイされています — 再起動は不要です。）

セッションを開き、右の sidebar を展開して **file** タブを選びます。`⬆ Upload` と `🗜 ZIP` は再読み込みボタンの隣にあり、その間のチップには、それらが対象とするフォルダーが表示されます。任意のファイルを開くと、`⬇ Download` が「open with」コントロールの隣に現れます。

## リバースプロキシの背後で使う

アップロードに合ったボディーサイズ上限を設定してください。nginx の場合：

```nginx
client_max_body_size 100m;
```

ほかに必要な設定はありません。ここでは認証はプロキシーの役目ではありません。ルートは DSH の Connection fetch レジストリーに登録されるため、有効なセッションを持たないリクエストが plugin に到達することはありません：

```console
$ curl -o /dev/null -w '%{http_code}\n' \
    'http://127.0.0.1:3900/api/dsh-file-transfer/download?path=/etc/hostname'
401
```

## 設定

すべてのオプションは任意です。同梱の patch を編集するのではなく、自分のプロファイルレイヤーから上書きしてください：

```yaml
- id: file-transfer
  config:
    roots: []              # allow-list of absolute roots; [] means unrestricted
    allowUpload: true
    allowOverwrite: false
    maxUploadBytes: 0      # 0 means no limit
    archiveMaxFiles: 20000
    archiveMaxBytes: 0     # 0 means no limit
    compressionLevel: 6    # 0-9, deflate level used by the ZIP route
```

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `roots` | `[]` | 空でない場合、ダウンロード・アップロード・アーカイブのすべての対象が、symlink も含めてこれらのルートのいずれかの内側に解決される必要があります。それ以外は `403 outside-roots` になります。 |
| `allowUpload` | `true` | `false` にするとアップロードルート自体が削除されます（`403 upload-disabled`）。 |
| `allowOverwrite` | `false` | オフの場合、既存の名前は置き換えられず、代わりに空いている `name-N.ext` が使われます。 |
| `maxUploadBytes` | `0` | これより大きいボディーを `413 upload-too-large` で拒否し、途中までのファイルを削除します。 |
| `archiveMaxFiles` | `20000` | エントリー数がこれを超えるツリーは ZIP 化を拒否します（`413 archive-too-large`）。 |
| `archiveMaxBytes` | `0` | ファイルの合計がこの予算を超えるツリーは ZIP 化を拒否します。`0` でチェックを無効にします。 |
| `compressionLevel` | `6` | アーカイブのエントリーに使う deflate レベル。`0` は圧縮せずに格納します。 |

## HTTP API

ルートは 3 つで、いずれも `/api/` の下にあり、すべて認証済みの Connection を必要とします。ターミナル、スクリプト、agent から利用できます：

```sh
# download (streams to stdout; add -r 0-1023 for a range)
curl -O -J 'https://host/api/dsh-file-transfer/download?path=/abs/report.pdf'

# upload (raw bytes, no multipart envelope)
curl -X POST -H 'content-type: application/octet-stream' \
  --data-binary @report.pdf \
  'https://host/api/dsh-file-transfer/upload?dir=/abs/dir&name=report.pdf'

# zip a directory (any name; defaults to the directory basename)
curl -OJ 'https://host/api/dsh-file-transfer/archive?path=/abs/reports'
```

アップロードに成功すると、次のように応答します：

```json
{ "ok": true, "value": { "path": "/abs/dir/report.pdf", "name": "report.pdf", "bytes": 20481 } }
```

失敗時は、harness のほかの部分と同じエンベロープを使います：

```json
{ "ok": false, "error": { "code": "outside-roots", "message": "path is outside the configured roots" } }
```

| コード | ステータス | 意味 |
| --- | --- | --- |
| `missing-path` | 400 | `path` / `dir` クエリーパラメーターがありません。 |
| `not-absolute` | 400 | パスが相対パスでした。 |
| `not-a-file` / `not-a-directory` | 400 | エントリーの種類が違います。 |
| `invalid-name` | 400 | 指定した名前を正規化した結果、使える文字が残りませんでした。 |
| `not-found` | 404 | パスが存在しません。 |
| `outside-roots` | 403 | 設定された `roots` の外側に解決されました。 |
| `upload-disabled` | 403 | `allowUpload: false` です。 |
| `name-exhausted` | 409 | 候補となる名前 10 000 個がすべて使われていました。 |
| `upload-too-large` | 413 | ボディーが `maxUploadBytes` を超えました。 |
| `archive-too-large` | 413 | ツリーが `archiveMaxFiles` / `archiveMaxBytes` を超えたか、1 つのエントリーが ZIP32 の範囲を超えています。 |
| `archive-unreadable` | 413 | ツリー内のディレクトリーを読み取れませんでした。 |
| `archive-failed` | 500 | アーカイブを生成できませんでした。 |
| `write-failed` | 500 | ホストがファイルを書き込めませんでした。 |

## セキュリティモデル

- **認証**は Connection fetch レジストリーから提供されます — 同梱の `/api/file` ルートが使っているのと同じ接続点です。匿名で到達できるルートはありません。
- **パス解決**では、ブラウザーから渡されたすべてのパスを `realpath` に通すため、`..` セグメントや symlink は `roots` のチェックより*前*に解決されます。許可されたルートの外を指す symlink は拒否され、これはユニットテストでも検証しています。
- **ファイル名**は単一のパスセグメントに縮められます。`../../etc/passwd` は `passwd` になり、選択したディレクトリーの内側に置かれます。ユニットテストだけでなく、エンドツーエンドでも検証済みです。
- **書き込み**は読み取り側から見てアトミックです（`.dsh-part-*` に書いてから rename）。明示的に要求しない限り、既存のファイルを上書きすることはありません。
- **アーカイブ**は symlink と特殊ファイルをスキップするディレクトリー走査から作られるため、workspace 内のリンクが外部のファイルをダウンロードに引き込むことはできません。走査は、バイト列を streaming する前に上限が適用されます。

plugin は harness プロセス自身の権限で動作します。harness を共有する場合、`roots` は公開する範囲を狭めるためのつまみであり、`allowUpload: false` は書き込み経路を完全に無効にします。

## 互換性

`@deepseek-ai/dsh` **0.2.0-rc.2** に対してビルド・検証しています。

このパッケージは**意図的に `peerDependencies` を宣言していません**。厳しすぎる peer レンジこそが、本来なら動作する plugin を DSH のバージョンゲートに拒否させる原因になります：

```console
dsh: installation rejected: Plugin <name> is incompatible with dsh 0.2.0-rc.2:
     peerDependencies {"@deepseek-ai/dsh-client-connection":"^0.1.0"}
```

この plugin がやり取りするのは `connection` サービスと Node の組み込みモジュールだけです。また、0.2 で削除されたパッケージ（たとえば `@deepseek-ai/dsh-client-runtime`）をクライアント側で import することも避けています。クライアント側の依存が欠けていると、ブラウザー側の半分がまったく有効化されなくなるためです。

## 開発

ビルドステップはありません。`lib/index.js`（ESM のホスト側）と `lib/client.js`（Web シェルの `__ModuleLoader__` 向けに手書きした CJS バンドル）が出荷される成果物で、どちらもコミットされているため、`github:` からのインストールが prepare スクリプトなしで動作します。

```sh
node --check lib/index.js && node --check lib/client.js
node --test test/host.test.mjs
```

ユニットテストは、エクスポートされたハンドラーを標準の `Request` オブジェクトで動かします。そのため Range、disposition、名前のサニタイズ、ルートの強制、上書きの挙動、サイズ上限、symlink 脱出、アーカイブの上限が、プロファイルを起動せずにすべて確認されます。ケースは 15 件で、ZIP 関連は Python の `zipfile.testzip()` によって、すべてのエントリーの CRC を走査して検証されます。

ツリーの操作にはブラウザーの自動テストがありません。同梱のファイルツリーの `data-files-entry` / `data-files-path` 属性を読んでおり、それゆえツリーの内部実装が変わっても動作し続けます。この配線に触れた場合は、実際の workspace で手動で確認してください。

## ロードマップ

- 複数選択：複数の行をまとめて ZIP 化、またはダウンロード。
- 配信済みファイルのカードにダウンロード操作を置く。現在 `deliverables.file.actions` はファイルシステムのパスではなく内部のアクション URL を返すため、これには上流側の仕組みが必要です。

## コントリビュート

issue と pull request を歓迎します。送る前に知っておいてほしいことが 2 つあります：

- **テストを実行する。** `node --test test/host.test.mjs` はグリーンのまま維持してください。
- **翻訳を同期させる。** README は 6 言語で存在し、どれも同じ plugin を説明するものです。挙動を変えたら、自分が書ける翻訳を更新し、その旨を PR で述べてください。残りはあとから追随できます。

表面は小さく保ってください。この plugin の価値は、DSH 自身のファイルブラウザーの上で少数のことを予測どおりに実行することにあり、IDE に育つことではありません。

## ライセンス

MIT
