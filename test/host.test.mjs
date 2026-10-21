/**
 * Unit tests for the dsh-file-transfer host handlers.
 *
 * These call the exported handlers with standard `Request` objects, so the
 * route logic is verified without booting a harness profile.
 * Run with: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execFileSync } from 'node:child_process'

import {
  ARCHIVE_PATH,
  DOWNLOAD_PATH,
  UPLOAD_PATH,
  handleArchive,
  handleDownload,
  handleUpload,
  resolveConfig,
  safeFilename,
} from '../lib/index.js'

const BASE = 'http://127.0.0.1:3900'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ft-'))
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function downloadUrl(path, name) {
  const url = new URL(BASE + DOWNLOAD_PATH)
  url.searchParams.set('path', path)
  if (name !== undefined) url.searchParams.set('name', name)
  return url.toString()
}

function uploadUrl(dir, name) {
  const url = new URL(BASE + UPLOAD_PATH)
  url.searchParams.set('dir', dir)
  url.searchParams.set('name', name)
  return url.toString()
}

test('safeFilename strips directory components and control characters', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd')
  assert.equal(safeFilename('/abs/path/report.pdf'), 'report.pdf')
  assert.equal(safeFilename('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe')
  assert.equal(safeFilename('repo\u0000rt.txt'), 'report.txt')
  assert.equal(safeFilename('a/b:c*d?e"f<g>h|i.txt'), 'b_c_d_e_f_g_h_i.txt')
  assert.equal(safeFilename('..'), undefined)
  assert.equal(safeFilename(''), undefined)
  assert.equal(safeFilename(undefined), undefined)
})

test('download streams bytes with an attachment disposition', async () => {
  const ws = workspace()
  try {
    const file = join(ws.root, '报告 final.txt')
    const payload = 'hello 世界\n'
    writeFileSync(file, payload)
    const options = resolveConfig({})

    const response = await handleDownload(new Request(downloadUrl(file)), options)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(payload)))
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="/)
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/)
    assert.equal(await response.text(), payload)
  } finally {
    ws.cleanup()
  }
})

test('download honours a single Range and answers HEAD without a body', async () => {
  const ws = workspace()
  try {
    const file = join(ws.root, 'range.bin')
    writeFileSync(file, 'abcdefghij')
    const options = resolveConfig({})

    const partial = await handleDownload(
      new Request(downloadUrl(file), { headers: { range: 'bytes=2-5' } }),
      options,
    )
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10')
    assert.equal(await partial.text(), 'cdef')

    const suffix = await handleDownload(
      new Request(downloadUrl(file), { headers: { range: 'bytes=-3' } }),
      options,
    )
    assert.equal(suffix.status, 206)
    assert.equal(await suffix.text(), 'hij')

    const head = await handleDownload(new Request(downloadUrl(file), { method: 'HEAD' }), options)
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')

    const invalid = await handleDownload(
      new Request(downloadUrl(file), { headers: { range: 'bytes=99-100' } }),
      options,
    )
    assert.equal(invalid.status, 416)
  } finally {
    ws.cleanup()
  }
})

test('download rejects missing, relative and out-of-root paths', async () => {
  const ws = workspace()
  try {
    const options = resolveConfig({})
    const missing = await handleDownload(new Request(downloadUrl(join(ws.root, 'nope'))), options)
    assert.equal(missing.status, 404)

    const relative = await handleDownload(new Request(downloadUrl('relative/path.txt')), options)
    assert.equal(relative.status, 400)
    assert.equal((await relative.json()).error.code, 'not-absolute')

    const file = join(ws.root, 'inside.txt')
    writeFileSync(file, 'inside')
    const scoped = resolveConfig({ roots: [join(ws.root, 'sub')] })
    mkdirSync(join(ws.root, 'sub'))
    const denied = await handleDownload(new Request(downloadUrl(file)), scoped)
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'outside-roots')
  } finally {
    ws.cleanup()
  }
})

test('upload writes streamed bytes and never overwrites by default', async () => {
  const ws = workspace()
  try {
    const options = resolveConfig({})
    const first = await handleUpload(
      new Request(uploadUrl(ws.root, 'notes.txt'), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('first'),
      }),
      options,
    )
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.equal(firstBody.ok, true)
    assert.equal(firstBody.value.bytes, 5)
    assert.equal(readFileSync(join(ws.root, 'notes.txt'), 'utf8'), 'first')

    const second = await handleUpload(
      new Request(uploadUrl(ws.root, 'notes.txt'), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('second'),
      }),
      options,
    )
    const secondBody = await second.json()
    assert.equal(secondBody.value.name, 'notes-1.txt')
    assert.equal(readFileSync(join(ws.root, 'notes.txt'), 'utf8'), 'first')
    assert.equal(readFileSync(join(ws.root, 'notes-1.txt'), 'utf8'), 'second')

    const noTemporaryLeft = existsSync(join(ws.root, 'notes-1.txt.dsh-part'))
    assert.equal(noTemporaryLeft, false)
  } finally {
    ws.cleanup()
  }
})

test('upload sanitises traversal names and refuses bad targets', async () => {
  const ws = workspace()
  try {
    const options = resolveConfig({})
    const escaping = await handleUpload(
      new Request(uploadUrl(ws.root, '../../escaped.txt'), {
        method: 'POST',
        body: Buffer.from('x'),
      }),
      options,
    )
    assert.equal(escaping.status, 200)
    const escapingBody = await escaping.json()
    assert.equal(escapingBody.value.name, 'escaped.txt')
    assert.equal(existsSync(join(ws.root, 'escaped.txt')), true)

    const missingDir = await handleUpload(
      new Request(uploadUrl(join(ws.root, 'nope'), 'a.txt'), { method: 'POST', body: Buffer.from('x') }),
      options,
    )
    assert.equal(missingDir.status, 404)

    const notADir = await handleUpload(
      new Request(uploadUrl(join(ws.root, 'escaped.txt'), 'a.txt'), {
        method: 'POST',
        body: Buffer.from('x'),
      }),
      options,
    )
    assert.equal(notADir.status, 400)
    assert.equal((await notADir.json()).error.code, 'not-a-directory')
  } finally {
    ws.cleanup()
  }
})

test('upload enforces maxUploadBytes and the allowUpload switch', async () => {
  const ws = workspace()
  try {
    const limited = resolveConfig({ maxUploadBytes: 4 })
    const tooBig = await handleUpload(
      new Request(uploadUrl(ws.root, 'big.bin'), {
        method: 'POST',
        body: Buffer.from('0123456789'),
      }),
      limited,
    )
    assert.equal(tooBig.status, 413)
    assert.equal((await tooBig.json()).error.code, 'upload-too-large')
    assert.equal(existsSync(join(ws.root, 'big.bin')), false)

    const disabled = resolveConfig({ allowUpload: false })
    const refused = await handleUpload(
      new Request(uploadUrl(ws.root, 'x.bin'), { method: 'POST', body: Buffer.from('x') }),
      disabled,
    )
    assert.equal(refused.status, 403)
    assert.equal((await refused.json()).error.code, 'upload-disabled')
  } finally {
    ws.cleanup()
  }
})

test('upload refuses to follow a symlink out of the allowed roots', async () => {
  const ws = workspace()
  const outside = workspace()
  try {
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outside.root, join(ws.root, 'escape'))
    const options = resolveConfig({ roots: [ws.root] })
    const response = await handleUpload(
      new Request(uploadUrl(join(ws.root, 'escape'), 'leak.txt'), {
        method: 'POST',
        body: Buffer.from('leak'),
      }),
      options,
    )
    assert.equal(response.status, 403)
    assert.equal(existsSync(join(outside.root, 'leak.txt')), false)
  } finally {
    ws.cleanup()
    outside.cleanup()
  }
})


const ZIP_INSPECT = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    bad = archive.testzip()
    names = sorted(archive.namelist())
    data = {}
    for name in names:
        if name.endswith('/'):
            continue
        data[name] = archive.read(name).decode('utf-8', 'replace')
print(json.dumps({'bad': bad, 'names': names, 'data': data}, ensure_ascii=False))
`

function archiveUrl(dir, name) {
  const url = new URL(BASE + ARCHIVE_PATH)
  url.searchParams.set('path', dir)
  if (name !== undefined) url.searchParams.set('name', name)
  return url.toString()
}

function inspectZip(zipPath) {
  return JSON.parse(execFileSync('python3', ['-c', ZIP_INSPECT, zipPath], { encoding: 'utf8' }))
}

test('archive streams a valid ZIP with CJK names, nesting and empty entries', async () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.root, 'a.txt'), 'alpha\n')
    writeFileSync(join(ws.root, '中文 名.md'), '# 标题\n')
    writeFileSync(join(ws.root, 'empty.txt'), '')
    mkdirSync(join(ws.root, 'sub', 'nested'), { recursive: true })
    writeFileSync(join(ws.root, 'sub', 'b.txt'), 'beta\n')
    writeFileSync(join(ws.root, 'sub', 'nested', 'c.bin'), Buffer.from([0, 1, 2, 255]))
    mkdirSync(join(ws.root, 'emptydir'))
    symlinkSync('/etc/hostname', join(ws.root, 'escape-link'))

    const response = await handleArchive(new Request(archiveUrl(ws.root)), resolveConfig({}))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/zip')
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/)

    const zipPath = join(ws.root, 'out.zip')
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()))
    const report = inspectZip(zipPath)

    assert.equal(report.bad, null, 'zipfile.testzip() must report no corrupt entry')
    assert.deepEqual(report.names, [
      'a.txt',
      'empty.txt',
      'emptydir/',
      'sub/',
      'sub/b.txt',
      'sub/nested/',
      'sub/nested/c.bin',
      '中文 名.md',
    ])
    assert.equal(report.data['a.txt'], 'alpha\n')
    assert.equal(report.data['sub/b.txt'], 'beta\n')
    assert.equal(report.data['中文 名.md'], '# 标题\n')
    assert.equal(report.data['empty.txt'], '')
    assert.equal(report.names.includes('escape-link'), false, 'symlinks must be skipped')
  } finally {
    ws.cleanup()
  }
})

test('archive names the download and answers HEAD without a body', async () => {
  const ws = workspace()
  try {
    mkdirSync(join(ws.root, '报告 目录'))
    writeFileSync(join(ws.root, '报告 目录', 'x.txt'), 'x')
    const options = resolveConfig({})

    const explicit = await handleArchive(new Request(archiveUrl(join(ws.root, '报告 目录'), '季度汇总')), options)
    const disposition = explicit.headers.get('content-disposition')
    assert.match(disposition, /filename="[\x20-\x7e_]+\.zip"/)
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), '季度汇总.zip')

    const fallback = await handleArchive(new Request(archiveUrl(join(ws.root, '报告 目录'))), options)
    assert.equal(
      decodeURIComponent(fallback.headers.get('content-disposition').split("filename*=UTF-8''")[1]),
      '报告 目录.zip',
    )

    const head = await handleArchive(new Request(archiveUrl(join(ws.root, '报告 目录')), { method: 'HEAD' }), options)
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  } finally {
    ws.cleanup()
  }
})

test('archive refuses files, missing paths and out-of-root directories', async () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.root, 'plain.txt'), 'x')
    const options = resolveConfig({})

    const notDir = await handleArchive(new Request(archiveUrl(join(ws.root, 'plain.txt'))), options)
    assert.equal(notDir.status, 400)
    assert.equal((await notDir.json()).error.code, 'not-a-directory')

    const missing = await handleArchive(new Request(archiveUrl(join(ws.root, 'nope'))), options)
    assert.equal(missing.status, 404)

    const scoped = resolveConfig({ roots: [join(ws.root, 'only')] })
    mkdirSync(join(ws.root, 'only'))
    const denied = await handleArchive(new Request(archiveUrl(ws.root)), scoped)
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'outside-roots')
  } finally {
    ws.cleanup()
  }
})

test('archive enforces the file and byte caps', async () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.root, 'one.txt'), 'one')
    writeFileSync(join(ws.root, 'two.txt'), 'two')

    const byCount = await handleArchive(new Request(archiveUrl(ws.root)), resolveConfig({ archiveMaxFiles: 1 }))
    assert.equal(byCount.status, 413)
    assert.equal((await byCount.json()).error.code, 'archive-too-large')

    const byBytes = await handleArchive(new Request(archiveUrl(ws.root)), resolveConfig({ archiveMaxBytes: 2 }))
    assert.equal(byBytes.status, 413)
  } finally {
    ws.cleanup()
  }
})

test('archive of an empty directory is a valid empty ZIP', async () => {
  const ws = workspace()
  try {
    const response = await handleArchive(new Request(archiveUrl(ws.root)), resolveConfig({}))
    const zipPath = join(ws.root, 'empty.zip')
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()))
    const report = inspectZip(zipPath)
    assert.equal(report.bad, null)
    assert.deepEqual(report.names, [])
  } finally {
    ws.cleanup()
  }
})

test('upload into a nested directory lands beside its siblings', async () => {
  const ws = workspace()
  try {
    mkdirSync(join(ws.root, 'reports', '2026'), { recursive: true })
    const response = await handleUpload(
      new Request(uploadUrl(join(ws.root, 'reports', '2026'), 'q4.txt'), {
        method: 'POST',
        body: Buffer.from('q4 numbers'),
      }),
      resolveConfig({}),
    )
    assert.equal(response.status, 200)
    assert.equal(readFileSync(join(ws.root, 'reports', '2026', 'q4.txt'), 'utf8'), 'q4 numbers')
  } finally {
    ws.cleanup()
  }
})

test('archive tears down cleanly when the consumer cancels mid-stream', async () => {
  const ws = workspace()
  try {
    for (let index = 0; index < 24; index += 1) {
      writeFileSync(join(ws.root, `part-${index}.bin`), Buffer.alloc(65536, index))
    }
    const response = await handleArchive(new Request(archiveUrl(ws.root)), resolveConfig({}))
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    // An unhandled rejection from the torn-down pipeline would fail this run.
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(true)
  } finally {
    ws.cleanup()
  }
})
