/**
 * dsh-file-transfer — host half.
 *
 * Two authenticated routes on the Connection fetch registry:
 *
 * - `GET/HEAD /api/dsh-file-transfer/download?path=<abs>[&name=<filename>]`
 *   streams one file as an attachment. Supports `Range` (single range) and
 *   `HEAD`, sets `Content-Disposition` with an RFC 5987 `filename*` so CJK
 *   names survive, and never buffers the whole file in memory.
 *
 * - `POST /api/dsh-file-transfer/upload?dir=<abs>&name=<filename>`
 *   accepts a raw `application/octet-stream` body and streams it to a new
 *   file inside `dir`. The bytes never pass through a JSON envelope: the
 *   request body is piped straight to disk, then atomically renamed.
 *
 * Authentication is supplied by the Connection service before either handler
 * runs, exactly like the shipped `/api/file` and `/api/session/uploadFileBinary`
 * routes. No route here trusts a browser-supplied path without resolving it
 * through `realpath` and checking it against the configured roots.
 *
 * @module dsh-file-transfer
 */
import {
  createReadStream,
  createWriteStream,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw } from 'node:zlib'

/** Cordis plugin id. */
export const name = 'dsh-file-transfer'

/** Services this plugin needs before it may register its routes. */
export const inject = ['connection']

/** Route that streams a file to the browser as a download. */
export const DOWNLOAD_PATH = '/api/dsh-file-transfer/download'

/** Route that accepts one raw-byte upload. */
export const UPLOAD_PATH = '/api/dsh-file-transfer/upload'

/** Route that streams one directory as a ZIP archive. */
export const ARCHIVE_PATH = '/api/dsh-file-transfer/archive'

const BASE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
}

const DEFAULT_MIME = 'application/octet-stream'

const MIME_BY_EXTENSION = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.toml': 'application/toml; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.zip': 'application/zip',
}

/**
 * Resolve the plugin configuration into the shape the handlers use.
 * @param config - raw loader configuration.
 * @returns normalized options.
 */
export function resolveConfig(config = {}) {
  const rawRoots = Array.isArray(config?.roots) ? config.roots : []
  const roots = []
  for (const entry of rawRoots) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    if (!isAbsolute(entry)) continue
    try {
      roots.push(stripTrailingSep(realpathSync(entry)))
    } catch {
      // A configured root that does not exist is inert rather than fatal.
      roots.push(stripTrailingSep(resolve(entry)))
    }
  }
  const maxUploadBytes =
    Number.isInteger(config?.maxUploadBytes) && config.maxUploadBytes > 0
      ? config.maxUploadBytes
      : 0
  const archiveMaxFiles =
    Number.isInteger(config?.archiveMaxFiles) && config.archiveMaxFiles > 0
      ? config.archiveMaxFiles
      : 20000
  const archiveMaxBytes =
    Number.isInteger(config?.archiveMaxBytes) && config.archiveMaxBytes > 0
      ? config.archiveMaxBytes
      : 0
  return {
    roots,
    allowUpload: config?.allowUpload !== false,
    allowOverwrite: config?.allowOverwrite === true,
    maxUploadBytes,
    archiveMaxFiles,
    archiveMaxBytes,
    compressionLevel:
      Number.isInteger(config?.compressionLevel) &&
      config.compressionLevel >= 0 &&
      config.compressionLevel <= 9
        ? config.compressionLevel
        : 6,
  }
}

function stripTrailingSep(value) {
  return value.length > 1 && value.endsWith(sep) ? value.slice(0, -1) : value
}

function withinRoots(target, roots) {
  if (roots.length === 0) return true
  for (const root of roots) {
    if (target === root) return true
    if (target.startsWith(root.endsWith(sep) ? root : root + sep)) return true
  }
  return false
}

/**
 * Reduce a browser-supplied name to a single path segment.
 * @param raw - candidate filename.
 * @returns a safe basename, or undefined when nothing usable remains.
 */
export function safeFilename(raw) {
  if (typeof raw !== 'string') return undefined
  // Strip any directory component and every character a filesystem may treat
  // specially; the result can never escape the target directory.
  const leaf = basename(raw.replace(/\\/g, '/'))
  const cleaned = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+$/, '')
    .trim()
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return undefined
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned
}

function mimeOf(path) {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? DEFAULT_MIME
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Build the plugin's error envelope, matching the shipped `{ ok, error }` shape.
 * @param status - HTTP status code.
 * @param code - stable machine-readable error code.
 * @param message - human-readable detail.
 * @returns a JSON response.
 */
export function fail(status, code, message) {
  return json({ ok: false, error: { code, message } }, status)
}

/**
 * Resolve one browser-supplied absolute path, refusing escapes.
 * @param raw - the `path`/`dir` query value.
 * @param roots - configured allow-list; empty means unrestricted.
 * @param options - expected entry kind.
 * @returns the resolved real path and stat, or an error triple.
 */
export function resolveExisting(raw, roots, options = {}) {
  const { directory = false } = options
  if (typeof raw !== 'string' || raw.length === 0) {
    return { error: [400, 'missing-path', 'query parameter is required'] }
  }
  if (!isAbsolute(raw)) {
    return { error: [400, 'not-absolute', 'path must be absolute'] }
  }
  let real
  try {
    // realpath collapses `..` and resolves symlinks, so the roots check below
    // cannot be defeated by a link that points outside an allowed root.
    real = realpathSync(resolve(raw))
  } catch {
    return { error: [404, 'not-found', 'path does not exist'] }
  }
  let stat
  try {
    stat = statSync(real)
  } catch {
    return { error: [404, 'not-found', 'path does not exist'] }
  }
  if (directory && !stat.isDirectory()) {
    return { error: [400, 'not-a-directory', 'path is not a directory'] }
  }
  if (!directory && !stat.isFile()) {
    return { error: [400, 'not-a-file', 'path is not a regular file'] }
  }
  if (!withinRoots(real, roots)) {
    return { error: [403, 'outside-roots', 'path is outside the configured roots'] }
  }
  return { path: real, stat }
}

function parseRange(header, size) {
  if (typeof header !== 'string' || header.length === 0) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return { invalid: true }
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { invalid: true }
  let start
  let end
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true }
  if (start > end || start >= size) return { invalid: true }
  return { start, end: Math.min(end, size - 1) }
}

function uniqueTarget(dir, filename, allowOverwrite) {
  const candidate = join(dir, filename)
  if (allowOverwrite || !existsSync(candidate)) return { path: candidate, name: filename }
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  for (let i = 1; i < 10000; i += 1) {
    const name = `${stem}-${i}${extension}`
    const path = join(dir, name)
    if (!existsSync(path)) return { path, name }
  }
  return undefined
}

function existsSync(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Serve one file. Kept exported so it can be unit-tested without a live host.
 * @param request - authenticated request from the Connection registry.
 * @param options - resolved plugin options.
 * @returns the streaming response.
 */
export async function handleDownload(request, options) {
  const url = new URL(request.url)
  const target = resolveExisting(url.searchParams.get('path'), options.roots)
  if (target.error !== undefined) return fail(...target.error)

  const size = target.stat.size
  const filename = safeFilename(url.searchParams.get('name')) ?? basename(target.path)
  const headers = {
    ...BASE_HEADERS,
    'content-type': mimeOf(target.path),
    'content-disposition': contentDisposition(filename),
    'accept-ranges': 'bytes',
  }

  const range = parseRange(request.headers.get('range'), size)
  if (range?.invalid === true) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${size}` },
    })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? Math.max(0, size - 1)
  const length = size === 0 ? 0 : end - start + 1
  const status = range === undefined ? 200 : 206
  const responseHeaders = {
    ...headers,
    'content-length': String(length),
    ...(range === undefined ? {} : { 'content-range': `bytes ${start}-${end}/${size}` }),
  }

  if (request.method === 'HEAD') return new Response(null, { status, headers: responseHeaders })

  const stream =
    size === 0 ? Readable.toWeb(Readable.from([])) : Readable.toWeb(createReadStream(target.path, { start, end }))
  return new Response(stream, { status, headers: responseHeaders })
}

class UploadLimitError extends Error {
  constructor(limit) {
    super(`upload exceeds the configured limit of ${limit} bytes`)
    this.code = 'upload-too-large'
  }
}

function limitBytes(maxBytes) {
  if (maxBytes <= 0) return undefined
  let seen = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length
      if (seen > maxBytes) {
        callback(new UploadLimitError(maxBytes))
        return
      }
      callback(null, chunk)
    },
  })
}

/**
 * Receive one raw upload and stream it into `dir`.
 * @param request - authenticated request from the Connection registry.
 * @param options - resolved plugin options.
 * @returns a JSON result envelope.
 */
export async function handleUpload(request, options) {
  if (!options.allowUpload) {
    return fail(403, 'upload-disabled', 'uploads are disabled by configuration')
  }
  if (request.body === null) {
    return fail(400, 'empty-body', 'request body is required')
  }
  const url = new URL(request.url)
  const directory = resolveExisting(url.searchParams.get('dir'), options.roots, { directory: true })
  if (directory.error !== undefined) return fail(...directory.error)

  const requested = safeFilename(url.searchParams.get('name') ?? url.searchParams.get('filename'))
  if (requested === undefined) {
    return fail(400, 'invalid-name', 'a usable file name is required')
  }

  const target = uniqueTarget(directory.path, requested, options.allowOverwrite)
  if (target === undefined) {
    return fail(409, 'name-exhausted', 'no free file name could be derived')
  }

  const temporary = `${target.path}.dsh-part-${process.pid}-${Date.now()}`
  let bytes = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(null, chunk)
    },
  })
  const limiter = limitBytes(options.maxUploadBytes)
  const stages = [Readable.fromWeb(request.body), counter, ...(limiter === undefined ? [] : [limiter]), createWriteStream(temporary, { flags: 'wx' })]
  try {
    await pipeline(...stages)
    renameSync(temporary, target.path)
  } catch (error) {
    rmSync(temporary, { force: true })
    if (error?.code === 'upload-too-large') {
      return fail(413, 'upload-too-large', error.message)
    }
    if (error?.code === 'EEXIST') {
      return fail(409, 'already-exists', 'the destination already exists')
    }
    return fail(500, 'write-failed', error instanceof Error ? error.message : String(error))
  }

  return json({ ok: true, value: { path: target.path, name: target.name, bytes } })
}

// ─────────────────────────────────────────────────────── directory archive

/** CRC-32 table for the ZIP entries this module writes itself. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32Update(state, chunk) {
  let value = state
  for (let index = 0; index < chunk.length; index += 1) {
    value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8)
  }
  return value >>> 0
}

/** MS-DOS time and date fields, clamped to the epoch ZIP can express. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

class ArchiveLimitError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * List one directory tree breadth-first, refusing to grow past the caps.
 * Symlinks and special files are skipped: a ZIP carries no portable link
 * representation, and following links could escape the requested directory.
 * @param root - resolved absolute directory.
 * @param options - resolved plugin options carrying the archive caps.
 * @returns entries in stable path order.
 */
export function collectArchiveEntries(root, options) {
  const entries = []
  let files = 0
  let totalBytes = 0
  const queue = [{ absolute: root, relative: '' }]
  while (queue.length > 0) {
    const directory = queue.shift()
    let children
    try {
      children = readdirSync(directory.absolute, { withFileTypes: true })
    } catch (error) {
      throw new ArchiveLimitError(
        'archive-unreadable',
        `cannot read ${directory.absolute}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const child of children) {
      const absolute = join(directory.absolute, child.name)
      const relative = directory.relative === '' ? child.name : `${directory.relative}/${child.name}`
      if (child.isSymbolicLink()) continue
      if (child.isDirectory()) {
        entries.push({ absolute, relative, kind: 'directory' })
        queue.push({ absolute, relative })
        continue
      }
      if (!child.isFile()) continue
      let stat
      try {
        stat = statSync(absolute)
      } catch {
        continue
      }
      if (stat.size >= 0xffffffff) {
        throw new ArchiveLimitError(
          'archive-too-large',
          `${relative} exceeds the 4 GiB ZIP32 entry limit`,
        )
      }
      files += 1
      totalBytes += stat.size
      if (files > options.archiveMaxFiles) {
        throw new ArchiveLimitError(
          'archive-too-large',
          `directory holds more than ${options.archiveMaxFiles} files`,
        )
      }
      if (options.archiveMaxBytes > 0 && totalBytes > options.archiveMaxBytes) {
        throw new ArchiveLimitError(
          'archive-too-large',
          `directory exceeds the configured ${options.archiveMaxBytes} byte budget`,
        )
      }
      entries.push({ absolute, relative, kind: 'file', size: stat.size, modified: stat.mtime })
    }
  }
  entries.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0))
  return entries
}

/**
 * Stream a ZIP archive for one directory.
 *
 * Files are deflated as they stream, so the archive never sits in host memory.
 * Each non-empty entry carries a data descriptor (general-purpose bit 3) and
 * UTF-8 names (bit 11), which is what lets a CJK filename survive without the
 * extra field. Written by hand rather than through a dependency: the plugin
 * ships no runtime dependencies on purpose.
 * @param entries - collected entries in stable order.
 * @param options - resolved plugin options carrying the compression level.
 * @returns an async iterator of archive chunks.
 */
export async function* zipStream(entries, options) {
  const central = []
  let offset = 0

  for (const entry of entries) {
    const isDirectory = entry.kind === 'directory'
    const name = isDirectory ? `${entry.relative}/` : entry.relative
    const nameBytes = Buffer.from(name, 'utf8')
    const stamp = dosDateTime(entry.modified ?? new Date())
    const method = isDirectory ? 0 : 8
    const flags = 0x0800 | (isDirectory ? 0 : 0x0008)
    const localOffset = offset

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt32LE(0, 14) // crc — deferred to the data descriptor
    header.writeUInt32LE(0, 18) // compressed size — deferred
    header.writeUInt32LE(0, 22) // uncompressed size — deferred
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    yield header
    yield nameBytes
    offset += header.length + nameBytes.length

    let crc = 0
    let compressedSize = 0
    let uncompressedSize = 0

    if (!isDirectory) {
      let crcState = 0xffffffff
      const input = createReadStream(entry.absolute)
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          crcState = crc32Update(crcState, chunk)
          uncompressedSize += chunk.length
          callback(null, chunk)
        },
      })
      const deflate = createDeflateRaw({ level: options.compressionLevel })
      const drained = pipeline(input, counter, deflate)
      // A consumer that walks away mid-archive closes this generator; mark the
      // pipeline as handled so that teardown never surfaces as an unhandled
      // rejection in the host process.
      drained.catch(() => {})
      try {
        for await (const chunk of deflate) {
          compressedSize += chunk.length
          offset += chunk.length
          yield chunk
        }
        await drained
      } catch (error) {
        input.destroy()
        counter.destroy()
        deflate.destroy()
        await drained.catch(() => {})
        throw error
      }
      crc = (crcState ^ 0xffffffff) >>> 0

      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(compressedSize, 8)
      descriptor.writeUInt32LE(uncompressedSize, 12)
      yield descriptor
      offset += descriptor.length
    }

    central.push({ nameBytes, flags, method, stamp, crc, compressedSize, uncompressedSize, localOffset, isDirectory })
  }

  const centralStart = offset
  let centralSize = 0

  for (const entry of central) {
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4) // version made by
    record.writeUInt16LE(20, 6) // version needed
    record.writeUInt16LE(entry.flags, 8)
    record.writeUInt16LE(entry.method, 10)
    record.writeUInt16LE(entry.stamp.time, 12)
    record.writeUInt16LE(entry.stamp.date, 14)
    record.writeUInt32LE(entry.crc, 16)
    record.writeUInt32LE(entry.compressedSize, 20)
    record.writeUInt32LE(entry.uncompressedSize, 24)
    record.writeUInt16LE(entry.nameBytes.length, 28)
    record.writeUInt16LE(0, 30) // extra
    record.writeUInt16LE(0, 32) // comment
    record.writeUInt16LE(0, 34) // disk start
    record.writeUInt16LE(0, 36) // internal attributes
    record.writeUInt32LE(
      entry.isDirectory ? ((0o755 << 16) | 0x10) >>> 0 : (0o644 << 16) >>> 0,
      38,
    )
    record.writeUInt32LE(entry.localOffset, 42)
    yield record
    yield entry.nameBytes
    centralSize += record.length + entry.nameBytes.length
  }

  const trailer = Buffer.alloc(22)
  trailer.writeUInt32LE(0x06054b50, 0)
  trailer.writeUInt16LE(0, 4)
  trailer.writeUInt16LE(0, 6)
  trailer.writeUInt16LE(central.length, 8)
  trailer.writeUInt16LE(central.length, 10)
  trailer.writeUInt32LE(centralSize, 12)
  trailer.writeUInt32LE(centralStart, 16)
  trailer.writeUInt16LE(0, 20)
  yield trailer
}

/**
 * Serve one directory as a streamed ZIP download.
 * @param request - authenticated request from the Connection registry.
 * @param options - resolved plugin options.
 * @returns the streaming response.
 */
export async function handleArchive(request, options) {
  const url = new URL(request.url)
  const target = resolveExisting(url.searchParams.get('path'), options.roots, { directory: true })
  if (target.error !== undefined) return fail(...target.error)

  let entries
  try {
    entries = collectArchiveEntries(target.path, options)
  } catch (error) {
    if (error instanceof ArchiveLimitError) {
      return fail(413, error.code, error.message)
    }
    return fail(500, 'archive-failed', error instanceof Error ? error.message : String(error))
  }

  const requested = safeFilename(url.searchParams.get('name'))
  const stem = requested ?? (basename(target.path) || 'archive')
  const filename = stem.toLowerCase().endsWith('.zip') ? stem : `${stem}.zip`
  const headers = {
    ...BASE_HEADERS,
    'content-type': 'application/zip',
    'content-disposition': contentDisposition(filename),
  }
  // The size is only known after streaming, so HEAD advertises the route
  // without a length rather than buffering the archive to measure it.
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })

  return new Response(Readable.toWeb(Readable.from(zipStream(entries, options))), {
    status: 200,
    headers,
  })
}

/**
 * Register the plugin's routes on the Connection fetch registry.
 * @param ctx - host context carrying the Connection service.
 * @param config - raw loader configuration.
 */
export function apply(ctx, config = {}) {
  const options = resolveConfig(config)
  const connection = ctx.get('connection')
  if (connection?.fetch?.register === undefined) {
    ctx.logger?.warn?.('dsh-file-transfer: connection.fetch is unavailable; routes not registered')
    return
  }
  ctx.effect(
    () =>
      connection.fetch.register({
        path: DOWNLOAD_PATH,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => handleDownload(request, options),
      }),
    'file-transfer: download route',
  )
  ctx.effect(
    () =>
      connection.fetch.register({
        path: UPLOAD_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: (request) => handleUpload(request, options),
      }),
    'file-transfer: upload route',
  )
  ctx.effect(
    () =>
      connection.fetch.register({
        path: ARCHIVE_PATH,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => handleArchive(request, options),
      }),
    'file-transfer: archive route',
  )
}
