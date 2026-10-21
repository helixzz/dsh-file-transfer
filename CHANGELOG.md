# Changelog

Notable changes to `dsh-file-transfer`. This project follows
[Semantic Versioning](https://semver.org/).

## 0.2.0 — unreleased

**Directory archive**

- `GET/HEAD /api/dsh-file-transfer/archive` streams one directory as a ZIP:
  recursive, empty directories preserved, UTF-8 names, symlinks and special
  files skipped.
- The archive is written against the ZIP specification directly (local headers
  with data descriptors, central directory, EOCD), so the plugin still has no
  runtime dependencies. Entries deflate through `node:zlib` as they stream; the
  archive is never buffered whole.
- Caps: `archiveMaxFiles` (default 20 000), `archiveMaxBytes` (default off), and
  a hard refusal for any single entry above the ZIP32 4 GiB limit.
- `compressionLevel` (0-9) controls the deflate level.

**Tree controls**

- The upload control now targets the folder currently selected in the file
  tree, not just the workspace root. Clicking a folder row selects it; clicking
  a file row selects its parent; a chip beside the button always names the
  destination.
- Drag and drop: dropping files on a folder row uploads into that folder, on a
  file row into its parent, and on empty space into the root. The row under the
  pointer is outlined during the drag.
- New `🗜 ZIP` control archives the selected folder in one click.
- The current folder is read from the shipped file tree's own
  `data-files-entry` / `data-files-path` attributes, so no part of the tree is
  re-implemented.

**Tests**

- Fourteen cases now, including four archive cases whose output is validated by
  Python's `zipfile.testzip()` entry by entry.

## 0.1.0 — 2026-10-17

Initial release, verified against `@deepseek-ai/dsh` `0.2.0-rc.2`.

**Host half**

- `GET/HEAD /api/dsh-file-transfer/download` — streams a file as an attachment,
  with single-`Range` support (`206 Partial Content`), `HEAD`, and an RFC 5987
  `filename*` so non-ASCII names survive.
- `POST /api/dsh-file-transfer/upload` — accepts a raw byte stream and writes it
  to disk without a multipart or base64 envelope; writes to a `.dsh-part-*`
  sibling and renames atomically, and never overwrites by default.
- Both routes are registered on the Connection fetch registry, so
  authentication is enforced before the handlers run (`401` without a session).
- Configuration: `roots`, `allowUpload`, `allowOverwrite`, `maxUploadBytes`.
- Path safety: `realpath` resolution before the roots check, so `..` segments and
  symlink escapes are refused; file names are reduced to one path segment.

**Client half**

- `⬇ Download` injected into `sidebar.right.tab.document.actions`, next to the
  "open with" control.
- `⬆ Upload` injected into `sidebar.right.tab.files.actions`, next to the reload
  button.
- Header-only dependency surface: the `slots` service and the shell's `react`
  module. No `peerDependencies`, by design — a tight peer range is what makes
  DSH's version gate refuse an otherwise working plugin.
- The picker input is kept out of the accessibility tree and the tab order.

**Tests**

- `node --test test/host.test.mjs` — eight cases covering dispositions, ranges,
  `HEAD`, name sanitising, traversal neutralisation, root enforcement, overwrite
  behaviour, size limits, and symlink escapes.
