# dsh-file-transfer

从 DeepSeek Harness 的 Web 侧边栏直接下载与上传文件 —— 面向远程访问，而不只是本机。

[English](README.md)

## 为什么做这个

DSH 的 Web 侧边栏自带工作区文件树和多种格式预览，但两个方向都是只读的：

- `workspaceFiles` 命名空间只有 `list` / `read` / `readBytes` / `stat` / `changes`，
  没有任何写入口，所以没法往工作区目录上传文件。
- 没有任何路由设置 `Content-Disposition`，所以预览到的文件没法保存下来 ——
  只能回宿主机手动拷（`scp`、U 盘……）。

如果 harness 跑在无头主机上、你只通过网络访问它，这个缺口就是
「打开报告点保存」和「登录服务器自己拷」之间的差别。

本插件用两条流式路由 + 侧边栏两个按钮把它补上。

## 你会得到什么

| 位置 | 控件 | 作用 |
| --- | --- | --- |
| 侧边栏文件预览标题栏 | `⬇ 下载` | 把正在预览的文件存到你的电脑，保留原文件名（中文名不乱码）。 |
| 侧边栏文件树头部 | `⬆ 上传` | 把选中的文件送进工作区根目录；同名文件绝不覆盖。 |

![侧边栏文件标签页，上传按钮就在重新读取旁边](docs/screenshot-files.png)

两条路由都是流式的：

- **下载**支持 `HEAD` 和单段 `Range`，所以大文件的续传、探测都可用，字节不会
  先在宿主内存里攒成一整块。
- **上传**把请求体直接管道写入磁盘，完成后再原子改名。端到端验证过一个 2 MiB
  文件字节完全一致；没有 JSON/base64 信封，不会把内存撑爆、也不会让体积涨 33%。

## 安装

```sh
dsh plugin --profile web add dsh-file-transfer
```

从本地目录安装（也就是本仓库）：

```sh
dsh plugin --profile web add /path/to/dsh-file-transfer
```

包内声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会自动把它追加进 profile 的
`dsh.profile.bundles` 层栈。重启 profile 并刷新页面：

```sh
systemctl --user restart deepseek-harness.service   # 或你平时启动 dsh web 的方式
```

打开一个会话、展开右侧边栏、点文件标签页：`⬆ 上传` 就在「重新读取」旁边。
点开任意文件：`⬇ 下载` 就在「打开方式」旁边。

### 反向代理

除了把请求体上限调到能容纳你的上传之外，无需额外配置。nginx 例：

```nginx
client_max_body_size 100m;
```

认证不靠代理：路由注册在 DSH 的 Connection fetch 注册表上，未认证请求在进入
handler 之前就被拒（`401`）。已实测：

```sh
curl -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3900/api/dsh-file-transfer/download?path=/etc/hostname'
# 401
```

## 配置

全部可选项。请在你自己的 profile 层覆盖，而不是改包内的 patch：

```yaml
- id: file-transfer
  config:
    roots: []            # 允许的绝对根目录白名单；[] 表示不限制
    allowUpload: true
    allowOverwrite: false
    maxUploadBytes: 0    # 0 表示不限
```

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `roots` | `[]` | 非空时，下载与上传目标经 `realpath` 解析后必须落在其中之一，否则 `403 outside-roots`。 |
| `allowUpload` | `true` | 置 false 可整体关闭上传路由（`403 upload-disabled`）。 |
| `allowOverwrite` | `false` | 关闭时，同名文件会变成 `report-1.pdf`，不覆盖原件。 |
| `maxUploadBytes` | `0` | 超出则 `413 upload-too-large`，并删掉写了一半的文件。 |

## API

两条路由都在 `/api/` 下，且都要求已认证的 Connection。

```sh
# 下载（流式；加 -r 0-1023 即 Range 请求）
curl -O -J 'https://host/api/dsh-file-transfer/download?path=/abs/report.pdf'

# 上传（裸字节，无 multipart 信封）
curl -X POST -H 'content-type: application/octet-stream' \
  --data-binary @report.pdf \
  'https://host/api/dsh-file-transfer/upload?dir=/abs/dir&name=report.pdf'
```

错误沿用出货约定：

```json
{ "ok": false, "error": { "code": "outside-roots", "message": "path is outside the configured roots" } }
```

错误码：`missing-path`、`not-absolute`、`not-found`、`not-a-file`、
`not-a-directory`、`outside-roots`、`invalid-name`、`name-exhausted`、
`empty-body`、`upload-disabled`、`upload-too-large`、`write-failed`。

## 安全模型

- **认证**来自 Connection fetch 注册表 —— 和出货的 `/api/file` 路由同一套接缝，
  没有任何匿名可达的路由。
- **路径解析**对浏览器传来的每个路径都做 `realpath`，`..` 与符号链接都会先被展开，
  再做 `roots` 检查。指向允许范围之外的符号链接会被拒绝，单元测试对此有断言。
- **文件名**会被压成单个路径段：`../../etc/passwd` 变成 `passwd`，落在你指定的目录里。
  已端到端验证。
- **写入**先落到同目录的 `.dsh-part-*` 临时文件，流结束后才改名就位，所以中断的上传
  不会在正式文件名下留下截断的内容。

插件以 harness 进程自身的权限运行；`roots` 是 harness 被多人共用时的收口手段。

## 与其它插件的关系

`sidebar.right.tab.document.actions` 和 `sidebar.right.tab.files.actions` 正是出货的
「打开方式」控件所用的槽位 —— 那个控件在浏览器远程访问时毫无用处（它是在服务器上
打开文件）。`⬇ 下载` 就是它旁边一直缺的那个按钮。

如果你要的是**对话内**收发文件（`📎` 输入框附件、`send_files` 工具、静态共享目录），
请看 [fengs2021/dsh-file-bridge](https://github.com/fengs2021/dsh-file-bridge)；
本插件刻意留在侧边栏，服务 harness 本来就能读到的任意路径。

## 兼容性

基于 `@deepseek-ai/dsh` `0.2.0-rc.2`（撰写时的 npm `latest`）构建并验证。

包内**刻意不声明** `peerDependencies`：过紧的 peer 区间正是 DSH 版本门拒绝一个
本来可用的插件的原因（`dsh: installation rejected: ... is incompatible with dsh <version>`）。
本插件只与 `connection` 服务和 Node 内置模块打交道。

## 开发

没有构建步骤：`lib/index.js`（ESM 宿主半）与 `lib/client.js`（手写的 CJS bundle，
供 Web shell 的 `__ModuleLoader__` 加载）就是出货产物。

```sh
node --check lib/index.js && node --check lib/client.js
node --test test/host.test.mjs
```

单元测试用标准 `Request` 对象直接驱动导出的 handler，因此 Range、disposition、
文件名消毒、根目录约束、覆盖行为、体积上限与符号链接逃逸都能在不起 profile 的
情况下验证。

## 路线图

- 目录打包成单个 ZIP 下载。
- 上传到文件树当前所在的目录，以及拖拽上传。
- 交付卡片上加下载控件（需要公开路径，因为 `deliverables.file.actions` 目前只给
  一个内部 action URL）。

## 许可

MIT
