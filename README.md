# Codex Desktop Token Monitor

Codex 桌面端本地 Token 用量监控面板。读取本机 JSONL 会话日志，展示每日和累计用量、缓存命中率、会话及子代理明细。

无需 API Key，无 npm 运行依赖，无外部 CDN。监控程序本身不调用模型，也不消耗模型 Token。它是独立的本地工具，不是 OpenAI 官方账单系统。

## 环境要求

- Node.js 20 或更新版本。
- 本机保留了 Codex Desktop 会话日志。
- Windows 可使用附带的双击启动和停止脚本。其他系统可以通过 Node.js 命令启动；目前已在 Windows 上验证。

## 快速开始

在项目根目录执行：

```sh
npm start
```

浏览器打开 `http://127.0.0.1:4318`。自动打开浏览器可以执行：

```sh
npm run start:open
```

也可以直接运行 `node server.mjs --open`。无需先执行 `npm install`。

Windows 用户可双击 `start.cmd`。如果默认端口已经运行本工具，会直接打开现有面板。服务仅监听 `127.0.0.1`；默认端口被其他程序占用时，会自动尝试接下来的 30 个端口，以终端显示的地址为准。

## 停止服务

在启动终端按 `Ctrl+C`，或关闭启动服务的终端窗口。Windows 也可双击 `stop.cmd` 停止默认端口上的实例，包括在后台启动的实例。

非默认端口可以执行：

```powershell
powershell -File stop.ps1 -Port 4319
```

关闭浏览器标签页不会停止服务。电脑重启后需要重新启动；项目未配置开机自启。

## 配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_HOME` | 用户主目录下的 `.codex` | 读取其中的 `sessions` 和 `archived_sessions` |
| `PORT` | `4318` | 起始监听端口；`--port=数字` 参数优先 |
| 页面刷新 | 5 秒 | 可暂停；标签页切回前台后立即刷新 |
| 日期时区 | 本机系统时区 | 决定今日范围和每日用量归属 |

例如，PowerShell 中指定日志目录及端口：

```powershell
$env:CODEX_HOME = 'D:\local-data\codex'
node server.mjs --port=4320
```

Windows 双击启动脚本优先检查默认端口。使用自定义目录或端口时，直接运行 Node.js 命令。

## 功能

- 今日 / 累计输入、输出及总 Token。
- 7 / 30 天用量趋势，缓存命中率和推理输出明细。
- 主会话 / 子代理筛选，按项目、模型或会话 ID 搜索。
- 按用量或时间排序、分页及会话详情。
- CSV 导出，导出所有符合当前筛选条件的会话。

## 统计口径

1. 通过 `session_meta` 识别桌面端会话及其子代理，读取 `event_msg` 中的 `token_count` 记录。
2. 用累计计数的变化量统计新增用量，跳过重复快照。按事件的本机日期归入每日统计。
3. 缓存输入已包含在输入 Token 中，推理输出已包含在输出 Token 中。总量不再重复加入这两项。
4. 归档副本按会话身份去重；子代理继承的历史记录不再次计入。子代理独立列出，不同时加进父会话一行。
5. 首次扫描完整历史，后续增量读取。正在写入的半行 JSON 等待写完后再解析。

缓存写入作为独立明细展示，不在现有总 Token 之外额外累加。CSV 汇总请使用总 Token 列。

## 数据范围与限制

- 累计用量仅代表本机现存且可识别的日志。删除的日志、其他设备和未落盘的云端任务可能不在其中。
- 工具不维护另一个历史数据库；删除源日志后，相应历史统计也会减少。
- Token 总量不等于套餐已用百分比，不能直接当作账单金额。
- 会话模型列显示最近记录的模型；如果会话中切换过模型，该列不代表全部历史用量的模型归属。
- 日志计数重置或分支继承信息不完整时，只计入能够归属的用量，异常会显示在面板中。
- JSONL 是本地日志格式，可能随 Codex 版本变化；出现新格式时解析器可能需要适配。

工具只读取日志，不修改 Codex 配置、认证或会话文件。网页静态资源均在仓库中。本地 API 的会话明细包含项目路径和会话标识；导出的 CSV 也可能包含这些本机信息。

## 开发与测试

```sh
npm test
```

测试使用临时目录和合成记录，不依赖个人 Codex 数据。覆盖累计计数、重复记录、跨日统计、归档、子代理继承、计数重置、增量读取和 HTTP 服务。

GitHub Actions 配置了 Windows / Linux、Node.js 20 / 24 的测试矩阵。推送到 GitHub 后运行，以实际 CI 结果为准。

```text
codex-desktop-token-monitor/
  server.mjs                 本地 HTTP 服务
  usage.mjs                  日志解析与增量统计
  public/                    页面、样式、脚本及本地图标
  test/                      合成数据测试
  .github/workflows/test.yml  GitHub Actions
  start.cmd / start.ps1       Windows 启动入口
  stop.cmd / stop.ps1         Windows 停止入口
```

## 发布说明

`.gitignore` 已排除本地配置、日志、会话 JSONL、CSV 导出和测试截图。不要将个人 `.codex` 数据目录放入仓库。

项目原始代码尚未选定开源许可证。公开发布时请按自己的分发意图决定许可证。随附 Lucide 图标的许可见 `THIRD_PARTY_NOTICES.md` 和 `public/assets/lucide-LICENSE.txt`。
