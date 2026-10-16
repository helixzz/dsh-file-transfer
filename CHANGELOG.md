# Changelog

Notable changes to `dsh-file-transfer`. This project follows
[Semantic Versioning](https://semver.org/).

## 0.1.0 — unreleased

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
