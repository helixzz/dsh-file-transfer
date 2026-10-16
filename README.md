# dsh-file-transfer

Download and upload files from the DeepSeek Harness Web sidebar — over a remote
connection, not just on localhost.

[中文说明](README.zh.md)

## Why

DSH's Web sidebar ships a workspace file tree with preview for many formats, but
it is read-only in both directions:

- `workspaceFiles` exposes only `list` / `read` / `readBytes` / `stat` / `changes`,
  so there is no upload path into a workspace directory.
- Nothing sets `Content-Disposition`, so a previewed file cannot be saved without
  going back to the host and copying it out by hand (`scp`, a USB stick, ...).

If the harness runs on a headless box and you reach it through a browser, that
gap is the difference between "open the report and click save" and "log into the
server and copy the file yourself".

This plugin closes it with two streaming routes and two sidebar buttons.

## What you get

| Where | Control | What it does |
| --- | --- | --- |
| Sidebar file preview header | `⬇ Download` | Saves the previewed file to your computer, with the original name (CJK included). |
| Sidebar file tree header | `⬆ Upload` | Sends the files you pick into the workspace root; existing names are never overwritten. |

![The sidebar file tab with the upload control next to the reload button](docs/screenshot-files.png)

Both routes stream:

- **Download** supports `HEAD` and a single `Range`, so resuming or previewing a
  large file works and the bytes never sit in host memory as one buffer.
- **Upload** pipes the raw request body straight to disk, then renames
  atomically. A 2 MiB file was verified byte-identical end to end; there is no
  JSON/base64 envelope to blow up memory or inflate size by 33%.

## Install

```sh
dsh plugin --profile web add dsh-file-transfer
```

From a local checkout (what this repository is):

```sh
dsh plugin --profile web add /path/to/dsh-file-transfer
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the
profile's `dsh.profile.bundles` layer stack automatically. Restart the profile
and reload the page:

```sh
systemctl --user restart deepseek-harness.service   # or however you run dsh web
```

Open a session, open the right sidebar, click the file tab: `⬆ Upload` sits next
to the reload button. Click any file: `⬇ Download` sits next to the
"open with" control.

### Behind a reverse proxy

Nothing special is required beyond a body-size limit that fits your uploads.
For nginx:

```nginx
client_max_body_size 100m;
```

Authentication is not your proxy's job here: the routes are registered on DSH's
Connection fetch registry, so an unauthenticated request is refused with `401`
before the handler runs. Verified:

```sh
curl -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3900/api/dsh-file-transfer/download?path=/etc/hostname'
# 401
```

## Configuration

All options are optional. Override them from your own profile layer rather than
editing the bundled patch:

```yaml
- id: file-transfer
  config:
    roots: []            # allow-list of absolute roots; [] means unrestricted
    allowUpload: true
    allowOverwrite: false
    maxUploadBytes: 0    # 0 means no limit
```

| Option | Default | Meaning |
| --- | --- | --- |
| `roots` | `[]` | When non-empty, every download and upload target must resolve (symlinks included) inside one of these roots. Others get `403 outside-roots`. |
| `allowUpload` | `true` | Turn the upload route off entirely (`403 upload-disabled`). |
| `allowOverwrite` | `false` | When off, an existing name becomes `report-1.pdf` instead of replacing the file. |
| `maxUploadBytes` | `0` | Reject larger bodies with `413 upload-too-large`; the partial file is removed. |

## API

Both routes live under `/api/` and require an authenticated Connection.

```sh
# download (streams; add -r 0-1023 for a range)
curl -O -J 'https://host/api/dsh-file-transfer/download?path=/abs/report.pdf'

# upload (raw bytes, no multipart envelope)
curl -X POST -H 'content-type: application/octet-stream' \
  --data-binary @report.pdf \
  'https://host/api/dsh-file-transfer/upload?dir=/abs/dir&name=report.pdf'
```

Errors use the shipped envelope, e.g.:

```json
{ "ok": false, "error": { "code": "outside-roots", "message": "path is outside the configured roots" } }
```

Codes: `missing-path`, `not-absolute`, `not-found`, `not-a-file`,
`not-a-directory`, `outside-roots`, `invalid-name`, `name-exhausted`,
`empty-body`, `upload-disabled`, `upload-too-large`, `write-failed`.

## Security model

- **Authentication** comes from the Connection fetch registry, the same seam the
  shipped `/api/file` route uses. No route is reachable anonymously.
- **Path resolution** runs every browser-supplied path through `realpath`, so
  `..` segments and symlinks are resolved before the `roots` check. A symlink
  pointing outside an allowed root is refused, and the unit tests assert it.
- **File names** are reduced to a single path segment; `../../etc/passwd` becomes
  `passwd` and lands inside the chosen directory. Verified end to end.
- **Writes** go to a `.dsh-part-*` sibling first and are only renamed into place
  after the stream completes, so an interrupted upload cannot leave a truncated
  file under the real name.

The plugin runs with the harness process's own privileges. `roots` is the knob
to hand out a narrower surface when the harness is shared.

## How it relates to other plugins

`sidebar.right.tab.document.actions` and `sidebar.right.tab.files.actions` are
the same slots the shipped "open with" control uses. That control is useless when
the browser is remote — it opens the file on the server. `⬇ Download` is the
button that was missing next to it.

For conversation-time file exchange (`📎` composer attachments, a `send_files`
tool, a static share directory), see
[fengs2021/dsh-file-bridge](https://github.com/fengs2021/dsh-file-bridge)
instead; this plugin deliberately stays in the sidebar and serves any path the
harness can already read.

## Compatibility

Built and verified against `@deepseek-ai/dsh` `0.2.0-rc.2` (the npm `latest` at
the time of writing).

The package declares **no** `peerDependencies` on purpose: an over-tight peer
range is what makes DSH's version gate refuse an otherwise working plugin
(`dsh: installation rejected: ... is incompatible with dsh <version>`). The
plugin talks only to the `connection` service and Node built-ins.

## Development

No build step: `lib/index.js` (ESM host half) and `lib/client.js` (hand-written
CJS bundle for the Web shell's `__ModuleLoader__`) are the shipped artifacts.

```sh
node --check lib/index.js && node --check lib/client.js
node --test test/host.test.mjs
```

The unit tests drive the exported handlers with standard `Request` objects, so
ranges, dispositions, name sanitising, root enforcement, overwrite behaviour,
size limits and symlink escapes are all checked without booting a profile.

## Roadmap

- Directory download as a single ZIP.
- Upload into the directory the tree currently shows, plus drag-and-drop.
- A download control on delivered-file cards (needs a public path, since
  `deliverables.file.actions` currently hands out an internal action URL only).

## License

MIT
