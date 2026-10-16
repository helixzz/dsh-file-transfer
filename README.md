# dsh-file-transfer

**English** · [简体中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH 0.2.0-rc.2 verified](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2%20verified-4dabf7)](https://github.com/deepseek-ai/deepseek-harness)
[![No build step](https://img.shields.io/badge/build-none-brightgreen)](#development)

**Download files out of the DSH Web sidebar, and upload files back into the workspace — over a remote connection, not just on localhost.**

DeepSeek Harness ships a sidebar file tree that can browse and preview your workspace, but it is read-only in both directions. This plugin adds the two controls that were missing:

| | |
| --- | --- |
| ![The file tab of the right sidebar, with the Upload control next to the reload button](docs/screenshot-files.png) | ![A previewed text file, with the Download control in the preview header](docs/screenshot-download.png) |
| **⬆ Upload** in the file tree header — sends picked files into the workspace | **⬇ Download** in the preview header — saves the open file to your machine |

## Why this exists

If you run the harness on a headless box and reach it through a browser, two everyday things are missing:

- **You cannot get a file out.** Nothing in the sidebar sets `Content-Disposition`, so a previewed report, PDF, or image cannot be saved. You end up going back to the host and copying it out by hand — `scp`, a shared drive, a USB stick.
- **You cannot put a file in.** The workspace file service exposes `list` / `read` / `readBytes` / `stat` / `changes` and nothing else. There is no write path, so a file on your laptop has to be uploaded some other way before the agent can touch it.

This plugin is deliberately small and stays in the sidebar: it does not invent a new file browser, it adds the download and upload actions to the one you already use.

## Features

**⬇ Download**

- Streams the file — bytes never sit in host memory as one buffer.
- `HEAD` and single `Range` support, so resuming and probing work (`206 Partial Content`).
- `Content-Disposition: attachment` with an RFC 5987 `filename*`, so CJK and emoji names survive the round trip instead of arriving as `%E6%8A%A5...`.
- Correct content type per extension, plus `nosniff` and `no-store`.
- No size ceiling of its own.

**⬆ Upload**

- Raw-byte streaming straight to disk: no multipart envelope, no base64, no 33 % inflation.
- Written to a `.dsh-part-*` sibling first and renamed into place only after the stream completes, so an interrupted upload can never leave a truncated file under the real name.
- Never overwrites. A second `report.pdf` becomes `report-1.pdf`.
- Optional size cap (`maxUploadBytes`) that rejects oversized bodies and cleans up after itself.

**Both**

- Authenticated by DSH's own Connection layer — an unauthenticated request is refused with `401` before your handler runs. No CSRF token juggling, no separate login.
- Root allow-listing, `realpath` resolution, and symlink-escape refusal.
- Familiar error envelope (`{ ok: false, error: { code, message } }`) with stable machine-readable codes.

## Install

```sh
# from GitHub
dsh plugin --profile web add github:helixzz/dsh-file-transfer

# or from a local checkout
dsh plugin --profile web add /path/to/dsh-file-transfer
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` appends it to the profile's `dsh.profile.bundles` layer stack by itself — no manual `cordis.patch.yml` editing.

Then either restart the profile:

```sh
systemctl --user restart deepseek-harness.service   # or however you run dsh web
```

…or, if your profile runs with `patchReload: live`, let the loader pick the new bundle up and simply reload the page. (That is how this plugin is deployed on the machine it was written for — no restart needed.)

Open a session, expand the right sidebar, and pick the **file** tab. `⬆ Upload` sits next to the reload button. Open any file and `⬇ Download` sits next to the "open with" control.

## Behind a reverse proxy

Set a body-size limit that fits your uploads. For nginx:

```nginx
client_max_body_size 100m;
```

Nothing else is required. Authentication is not the proxy's job here: routes are registered on DSH's Connection fetch registry, so a request without a valid session never reaches the plugin:

```console
$ curl -o /dev/null -w '%{http_code}\n' \
    'http://127.0.0.1:3900/api/dsh-file-transfer/download?path=/etc/hostname'
401
```

## Configuration

Every option is optional. Override them from your own profile layer rather than editing the bundled patch:

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
| `roots` | `[]` | When non-empty, every download and upload target must resolve — symlinks included — inside one of these roots. Anything else gets `403 outside-roots`. |
| `allowUpload` | `true` | Set to `false` to remove the upload route entirely (`403 upload-disabled`). |
| `allowOverwrite` | `false` | When off, an existing name is never replaced; a free `name-N.ext` is used instead. |
| `maxUploadBytes` | `0` | Reject larger bodies with `413 upload-too-large` and delete the partial file. |

## HTTP API

Two routes, both under `/api/`, both requiring an authenticated Connection. Useful from a terminal, a script, or an agent:

```sh
# download (streams to stdout; add -r 0-1023 for a range)
curl -O -J 'https://host/api/dsh-file-transfer/download?path=/abs/report.pdf'

# upload (raw bytes, no multipart envelope)
curl -X POST -H 'content-type: application/octet-stream' \
  --data-binary @report.pdf \
  'https://host/api/dsh-file-transfer/upload?dir=/abs/dir&name=report.pdf'
```

A successful upload answers:

```json
{ "ok": true, "value": { "path": "/abs/dir/report.pdf", "name": "report.pdf", "bytes": 20481 } }
```

Failures use the same envelope as the rest of the harness:

```json
{ "ok": false, "error": { "code": "outside-roots", "message": "path is outside the configured roots" } }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `missing-path` | 400 | No `path` / `dir` query parameter. |
| `not-absolute` | 400 | The path was relative. |
| `not-a-file` / `not-a-directory` | 400 | Wrong kind of entry. |
| `invalid-name` | 400 | The supplied name reduced to nothing usable. |
| `not-found` | 404 | The path does not exist. |
| `outside-roots` | 403 | Resolved outside the configured `roots`. |
| `upload-disabled` | 403 | `allowUpload: false`. |
| `name-exhausted` | 409 | 10 000 candidate names were all taken. |
| `upload-too-large` | 413 | Body exceeded `maxUploadBytes`. |
| `write-failed` | 500 | The host could not write the file. |

## Security model

- **Authentication** comes from the Connection fetch registry — the same seam the shipped `/api/file` route uses. No route is reachable anonymously.
- **Path resolution** runs every browser-supplied path through `realpath`, so `..` segments and symlinks are resolved *before* the `roots` check. A symlink pointing outside an allowed root is refused, and a unit test asserts it.
- **File names** are reduced to a single path segment: `../../etc/passwd` becomes `passwd` and lands inside the chosen directory. Verified end to end, not just in a unit test.
- **Writes** are atomic from the reader's point of view (`.dsh-part-*` then rename), and never clobber an existing file unless you ask for it.

The plugin runs with the harness process's own privileges. `roots` is the knob to hand out a narrower surface when the harness is shared, and `allowUpload: false` turns the write path off completely.

## Compatibility

Built and verified against `@deepseek-ai/dsh` **0.2.0-rc.2**.

The package declares **no `peerDependencies` on purpose**. An over-tight peer range is exactly what makes DSH's version gate refuse an otherwise working plugin:

```console
dsh: installation rejected: Plugin <name> is incompatible with dsh 0.2.0-rc.2:
     peerDependencies {"@deepseek-ai/dsh-client-connection":"^0.1.0"}
```

This plugin talks only to the `connection` service and Node built-ins. It also avoids client-side imports of packages that were removed in 0.2 (for example `@deepseek-ai/dsh-client-runtime`), because a missing client dependency makes the whole browser half fail to activate.

## Development

There is no build step. `lib/index.js` (ESM host half) and `lib/client.js` (hand-written CJS bundle for the Web shell's `__ModuleLoader__`) are the shipped artifacts, and both are committed so `github:` installs work without a prepare script.

```sh
node --check lib/index.js && node --check lib/client.js
node --test test/host.test.mjs
```

The unit tests drive the exported handlers with standard `Request` objects — so ranges, dispositions, name sanitising, root enforcement, overwrite behaviour, size limits and symlink escapes are all checked without booting a profile. Eight cases, no fixture harness required.

## Roadmap

- Directory download as a single ZIP.
- Upload into the directory the tree currently shows (not just the workspace root), plus drag-and-drop.
- A download control on delivered-file cards. `deliverables.file.actions` currently hands out an internal action URL rather than a filesystem path, so this needs an upstream affordance.

## Contributing

Issues and pull requests are welcome. Two things to know before you send one:

- **Run the tests.** `node --test test/host.test.mjs` must stay green.
- **Keep translations in sync.** The README exists in six languages and they are meant to describe the same plugin; if you change behaviour, update the translation you can write and say so in the PR, and the rest can follow.

Please keep the surface small. This plugin's whole value is that it does two things predictably on top of DSH's own file browser, not that it grows into an IDE.

## License

MIT
