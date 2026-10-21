# dsh-file-transfer

[English](README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH 0.2.0-rc.2 verified](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2%20verified-4dabf7)](https://github.com/deepseek-ai/deepseek-harness)
[![No build step](https://img.shields.io/badge/build-none-brightgreen)](#开发)

**从 DSH 的 Web 侧边栏把文件下载出来、把文件上传回工作区，还能把整个目录打包带走 —— 走的是远程连接，不只是本机。**

DeepSeek Harness 自带一个能浏览、能预览工作区的侧边栏文件树，但两个方向都是只读的。本插件补上的就是缺的那几个控件：

| | |
| --- | --- |
| ![右侧边栏的文件标签页，重新读取旁边是上传、目标目录和打包](docs/screenshot-files.png) | ![预览中的文本文件，下载按钮在预览标题栏里](docs/screenshot-download.png) |
| 文件树头部的 **⬆ 上传** 与 **🗜 打包** —— 把文件送进你选中的目录，或把整个目录拿走 | 预览标题栏的 **⬇ 下载** —— 把打开的文件存到本机 |

## 为什么需要它

如果 harness 跑在无头主机上、你只通过浏览器访问它，有两件日常小事是做不到的：

- **文件拿不出来。** 侧边栏里没有任何地方设置 `Content-Disposition`，所以预览到的报告、PDF、图片都没法保存。最后只能回宿主机手动拷 —— `scp`、共享盘、U 盘。
- **文件送不进去。** 工作区文件服务只暴露 `list` / `read` / `readBytes` / `stat` / `changes`，没有写入路径。你笔记本上的文件得另想办法传上去，agent 才能碰它。

这个插件刻意做得很小，也刻意留在侧边栏里：它不另造一个文件浏览器，只是给你已经在用的那个补上「下载」和「上传」。

## 功能

**⬇ 下载**

- 流式传输 —— 字节不会先在宿主内存里攒成一整块。
- 支持 `HEAD` 和单段 `Range`，所以续传、探测都可用（`206 Partial Content`）。
- `Content-Disposition: attachment` 带 RFC 5987 的 `filename*`，中文名和 emoji 名能原样落地，不会变成 `%E6%8A%A5...`。
- 按扩展名给正确的 content type，并附 `nosniff` 与 `no-store`。
- 自身不设体积上限。

**⬆ 上传**

- 裸字节直接流式写盘：没有 multipart 信封、没有 base64、不会让体积涨 33%。
- 先写成同目录的 `.dsh-part-*`，流结束后才改名就位 —— 中断的上传不会在正式文件名下留下半截内容。
- 绝不覆盖。再次上传 `report.pdf` 会变成 `report-1.pdf`。
- 可选的体积上限（`maxUploadBytes`）：超限直接拒收，自己清理干净。
- **目标是「你正在看的那个目录」**，不只是工作区根：点一下目录行（点文件则用它所在的目录），按钮就跟着走；旁边的胶囊始终显示目标名。
- **把文件拖到文件树上**：拖到目录行就进那个目录，拖到文件行就用它的父目录，拖到空白处就用根目录。拖动时指针下的行会描边。

**🗜 目录打包**

- 一键把选中的目录变成单个压缩包：递归、中文名不乱码、空目录保留、符号链接跳过。
- 边压边传 —— 压缩包不会先在宿主内存里攒成一整块。
- 直接按 ZIP 规范手写（data descriptor + UTF-8 名称标志位），所以插件**至今仍是零运行时依赖**。
- 默认上限两万个文件，可另设字节预算；单个条目超过 4 GiB 会被拒绝（ZIP32 表达不了）。

**两者共同**

- 认证由 DSH 自己的 Connection 层负责 —— 未认证请求在进入 handler 之前就被 `401` 挡掉。不用管 CSRF token，也不用另做登录。
- 根目录白名单、`realpath` 解析、符号链接逃逸拒绝。
- 沿用出货的错误信封（`{ ok: false, error: { code, message } }`），错误码稳定、可被程序判断。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:helixzz/dsh-file-transfer

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-file-transfer
```

包内声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会自动把它追加进 profile 的 `dsh.profile.bundles` 层栈，不需要你手改 `cordis.patch.yml`。

然后二选一：

```sh
systemctl --user restart deepseek-harness.service   # 或你平时启动 dsh web 的方式
```

……或者，如果你的 profile 跑在 `patchReload: live` 下，让加载器自己拾取新 bundle，刷新页面即可。（本插件在它诞生那台机器上就是这样部署的 —— 无需重启。）

打开一个会话、展开右侧边栏、点「文件」标签页：`⬆ 上传` 和 `🗜 打包` 就在「重新读取」旁边，两者之间的胶囊写着它们会作用的目录。打开任意文件：`⬇ 下载` 就在「打开方式」旁边。

## 反向代理

把请求体上限调到能容纳你的上传即可。nginx 例：

```nginx
client_max_body_size 100m;
```

其他都不用配。认证在这里不是代理的职责：路由注册在 DSH 的 Connection fetch 注册表上，没有有效会话的请求根本到不了插件：

```console
$ curl -o /dev/null -w '%{http_code}\n' \
    'http://127.0.0.1:3900/api/dsh-file-transfer/download?path=/etc/hostname'
401
```

## 配置

全部可选项。请在你自己的 profile 层覆盖，而不是改包内的 patch：

```yaml
- id: file-transfer
  config:
    roots: []              # 允许的绝对根目录白名单；[] 表示不限制
    allowUpload: true
    allowOverwrite: false
    maxUploadBytes: 0      # 0 表示不限
    archiveMaxFiles: 20000
    archiveMaxBytes: 0     # 0 表示不限
    compressionLevel: 6    # 0-9，打包路由使用的 deflate 等级
```

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `roots` | `[]` | 非空时，下载与上传目标经 `realpath` 解析后（含符号链接）必须落在其中之一，否则 `403 outside-roots`。 |
| `allowUpload` | `true` | 置 `false` 可整体关闭上传路由（`403 upload-disabled`）。 |
| `allowOverwrite` | `false` | 关闭时同名文件绝不替换，改为使用空闲的 `name-N.ext`。 |
| `maxUploadBytes` | `0` | 超出则以 `413 upload-too-large` 拒收，并删掉写了一半的文件。 |
| `archiveMaxFiles` | `20000` | 目录条目超过此数拒绝打包（`413 archive-too-large`）。 |
| `archiveMaxBytes` | `0` | 目录内文件总字节超过此预算拒绝打包；`0` 关闭该检查。 |
| `compressionLevel` | `6` | 压缩包条目的 deflate 等级；`0` 表示只存储不压缩。 |

## HTTP API

三条路由都在 `/api/` 下，都要求已认证的 Connection。终端、脚本、agent 都能直接用：

```sh
# 下载（流式输出到 stdout；加 -r 0-1023 即 Range 请求）
curl -O -J 'https://host/api/dsh-file-transfer/download?path=/abs/report.pdf'

# 上传（裸字节，无 multipart 信封）
curl -X POST -H 'content-type: application/octet-stream' \
  --data-binary @report.pdf \
  'https://host/api/dsh-file-transfer/upload?dir=/abs/dir&name=report.pdf'

# 打包目录（可指定名称；默认用目录名）
curl -OJ 'https://host/api/dsh-file-transfer/archive?path=/abs/reports'
```

上传成功时返回：

```json
{ "ok": true, "value": { "path": "/abs/dir/report.pdf", "name": "report.pdf", "bytes": 20481 } }
```

失败沿用 harness 其余部分同样的信封：

```json
{ "ok": false, "error": { "code": "outside-roots", "message": "path is outside the configured roots" } }
```

| 错误码 | 状态 | 含义 |
| --- | --- | --- |
| `missing-path` | 400 | 缺少 `path` / `dir` 查询参数。 |
| `not-absolute` | 400 | 传了相对路径。 |
| `not-a-file` / `not-a-directory` | 400 | 条目类型不对。 |
| `invalid-name` | 400 | 提供的文件名被清洗后没有可用内容。 |
| `not-found` | 404 | 路径不存在。 |
| `outside-roots` | 403 | 解析后落在配置的 `roots` 之外。 |
| `upload-disabled` | 403 | `allowUpload: false`。 |
| `name-exhausted` | 409 | 10000 个候选名字都被占用了。 |
| `upload-too-large` | 413 | 请求体超过 `maxUploadBytes`。 |
| `archive-too-large` | 413 | 目录超过 `archiveMaxFiles` / `archiveMaxBytes`，或单个条目超出 ZIP32 上限。 |
| `archive-unreadable` | 413 | 目录树里有子目录无法读取。 |
| `archive-failed` | 500 | 压缩包无法生成。 |
| `write-failed` | 500 | 宿主写入失败。 |

## 安全模型

- **认证**来自 Connection fetch 注册表 —— 与出货的 `/api/file` 路由同一套接缝，没有任何匿名可达的路由。
- **路径解析**对浏览器传来的每个路径都做 `realpath`，`..` 段与符号链接会在 `roots` 检查**之前**被展开。指向允许范围之外的符号链接会被拒绝，单元测试对此有断言。
- **文件名**会被压成单个路径段：`../../etc/passwd` 变成 `passwd`，落在你指定的目录里。这条是端到端验证过的，不只是单元测试。
- **写入**从读者视角看是原子的（先 `.dsh-part-*` 再改名），且除非你明确要求，绝不覆盖已有文件。
- **打包**基于一次目录遍历，跳过符号链接与特殊文件 —— 工作区里的一个链接没法把外部文件拽进压缩包。遍历在任何字节被送出之前就完成上限检查。

插件以 harness 进程自身的权限运行。harness 被多人共用时，`roots` 是收窄暴露面的旋钮；`allowUpload: false` 可以彻底关掉写入路径。

## 兼容性

基于 `@deepseek-ai/dsh` **0.2.0-rc.2** 构建并验证。

包内**刻意不声明 `peerDependencies`**。过紧的 peer 区间正是 DSH 版本门拒绝一个本来可用的插件的原因：

```console
dsh: installation rejected: Plugin <name> is incompatible with dsh 0.2.0-rc.2:
     peerDependencies {"@deepseek-ai/dsh-client-connection":"^0.1.0"}
```

本插件只与 `connection` 服务和 Node 内置模块打交道。客户端侧也刻意不 import 那些在 0.2 里被移除的包（比如 `@deepseek-ai/dsh-client-runtime`），因为缺一个客户端依赖会让整个浏览器半边激活失败。

## 开发

没有构建步骤。`lib/index.js`（ESM 宿主半）和 `lib/client.js`（手写的 CJS bundle，供 Web shell 的 `__ModuleLoader__` 加载）就是出货产物，而且都提交进了仓库 —— 所以 `github:` 安装不需要 prepare 脚本。

```sh
node --check lib/index.js && node --check lib/client.js
node --test test/host.test.mjs
```

单元测试用标准 `Request` 对象直接驱动导出的 handler —— Range、disposition、文件名消毒、根目录约束、覆盖行为、体积上限、符号链接逃逸、打包上限全都能在不起 profile 的情况下验证。十五个用例；其中 ZIP 的几条由 Python 的 `zipfile.testzip()` 逐条校验 CRC。

文件树那套控件没有自动化浏览器测试：它读的是出货文件树的 `data-files-entry` / `data-files-path` 属性（也正因为如此，树内部改实现它也能跟着活）。改动这条线时，请对着真实工作区手工验一遍。

## 路线图

- 多选：一次打包或下载多行。
- 交付卡片上的下载控件。`deliverables.file.actions` 目前只给一个内部 action URL、不给文件系统路径，所以这一项需要上游先提供抓手。

## 参与贡献

欢迎提 issue 和 PR。动手之前有两件事值得知道：

- **跑测试。** `node --test test/host.test.mjs` 必须保持全绿。
- **保持各语言 README 同步。** 这份文档有六种语言，它们描述的是同一个插件；如果你改了行为，请更新你能写的那份翻译并在 PR 里说明，其余的可以随后跟上。

也请克制功能边界。这个插件的全部价值在于它在 DSH 自带文件浏览器之上稳定地做那几件事，而不是长成一个 IDE。

## 许可

MIT
