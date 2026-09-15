# dsh-claudia

**让个人 AI 助手不止是一个聊天框。**

DeepSeek Harness 原生双栏个人助手插件：左侧持续对话，右侧 Today、Journal、Todo、记忆和能力。默认名字 Claudia，可自行更改。复用同一 Harness 的默认模型、凭据、Agent 执行和会话持久化，不依赖 WorkBuddy，不另起一套模型系统。

版本 **0.3.0**。仓库：https://github.com/iamhej/dsh-claudia 。面向单用户本机，macOS 优先；与 Today、DeepSeek 无官方隶属或背书关系。

## 0.3.0 新增

- Todo 一行回车新增，勾选完成/撤销，单独忽略；完成与忽略折叠保留。
- Journal 内区分随手记录与每日回顾，Today 展示最新回顾。
- Markdown 本地业务记录，可外部编辑；版本冲突不会静默覆盖。
- `soul.md / user.md / system.md`：人格、用户画像、相处方式；只影响 Claudia 会话。
- 可选自动提出记忆候选，人工接受后才成为确认记忆，不擅自改写画像和人格。
- 可选 macOS 应用前台时长统计，不截图、不读应用内容。
- 本机时间每天 05:00 生成温和的 500—800 汉字回顾。
- 本机时间每天 06:00 检查本仓库正式 Release，校验后自动安装，空闲后由启动器重启生效。
- 设置提供数据目录、打开文件夹、打开实际 Harness 界面及后台常驻入口。
- 新启动器关闭宿主自动弹窗，待完整启动后只打开 Claudia 一次。

**时长采集、每日回顾、自动更新、记忆建议四个开关默认全部关闭。** 后台常驻也不会随安装偷偷注册，需在设置中单独确认。

## 安装前提

- Harness CLI `0.1.5-rc.1`，实测 Agent/LLM/System Prompt 依赖为 `0.1.5-rc.2`。其他版本需回归验证。
- Node.js `^22.19.0 || >=24.0.0`，需要内置 SQLite；实测 Node 22.22.2 和日常宿主 Node 24.19.0。
- 官方插件安装和自动更新需要 **pnpm**。建议终端中可执行 `pnpm --version`，也可通过启动参数 `--pnpm-path` 指定实际可执行入口。
- 已在同一 `DSH_HOME` 配置模型及凭据，不需要在 Claudia 重填 API key。
- 开启前台时长采集时需要 Apple Command Line Tools 提供 `xcrun swiftc`；首次开启编译一个小型本机组件，失败会明确显示，不自动索取录屏或辅助功能权限。

## 安装与启动

从 [Releases](https://github.com/iamhej/dsh-claudia/releases) 下载 `dsh-claudia-0.3.0.tgz`。可用同页的 `SHA256SUMS.txt` 核对哈希，然后执行：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-claudia-0.3.0.tgz --ignore-scripts
```

在终端使用包内启动器（下例 home 和端口可按需调整）：

```sh
node "$HOME/.dsh/profiles/web/node_modules/dsh-claudia/bin/claudia.mjs" start \
  --dsh-bin "$(command -v dsh)" \
  --home "$HOME/.dsh" --profile web \
  --port 3088 --plugin-port 4318 \
  --pnpm-path "$(command -v pnpm)"
```

- 启动后只自动打开 Claudia：上例为 `http://127.0.0.1:4318`。
- Harness 原界面仍保留，上例为 `http://127.0.0.1:3088`；在设置点击“打开 Harness”进入。
- 后台已有同 home/profile 的 Claudia 时，只打开已有页面，不重复启动。
- `--no-open` 禁止自动打开浏览器。
- 关闭启动器终端会停止它启动的服务。需要窗口关闭后仍持续统计/调度，可在设置单独启用后台服务。
- 安装与启动必须使用同一个 home/profile。CLI 的 `desktop` profile 为 Electron 保留，本文不提供桌面程序安装方式。
- 只执行 `dsh web` 也可加载插件，但默认仍遵循宿主开页逻辑，且没有 Claudia supervisor 承担自动升级后的重启；推荐上述启动方式。

从源码或 fork 安装可固定标签，严格复现时改用完整提交号：

```sh
dsh plugin --profile web add "git+https://github.com/iamhej/dsh-claudia.git#v0.3.0" --ignore-scripts
```

尚未发布 npm registry，不要假设按包名在线安装已可用。peerDependencies 警告可能出现，实际由宿主模块解析回退提供；不要仅因警告而另装第二份 Harness。

## 数据文件在哪里

默认目录 `<DSH_HOME>/claudia/`，设置显示实际目录并提供“打开文件夹”。

```text
claudia/
  soul.md                  人格，frontmatter 中 assistantName 是昵称唯一来源
  user.md                  用户确认的个人背景
  system.md                交互约定，不是权限或宿主系统配置
  settings.md              五项行为开关，不含 API key
  todo.md                  待办、完成与忽略状态
  memory.md                确认记忆及待审核候选
  journal/*.md             按稳定 ID 保存每条记录，内含时间元数据
  reflections/*.md         每日回顾及覆盖时间段
  conversations/*.md       可阅读的聊天副本
  activity/*.jsonl         前台应用时间段明细
  activity/*.md            时长汇总
  migration/*.md           迁移冲突或外部修改保留副本
  claudia.sqlite           聊天权威记录、宿主会话 ID 与运行索引
  .runtime/                本机采集组件、启动与更新状态
  .updates/                已校验更新包、旧版本备份
```

Journal、Todo、记忆和三份设定以 Markdown 为主来源。外部编辑请保留 frontmatter、稳定 ID、记录边界；修改正文或 Todo checkbox 可被回读。空文件/损坏格式会明确报错，不会悄悄生成内容覆盖。界面保存使用 revision 防止覆盖其他编辑。单个记录文件上限 8 MiB，三份设定每份最多 12000 字符。

聊天 Markdown 是可阅读副本，真正聊天权威仍是 SQLite 和宿主会话日志。外部编辑副本不会篡改模型历史；重新同步时原修改会保存在 `migration/`。首次升级将旧 SQLite Journal/记忆导入 Markdown，不覆盖既有 MD，保留旧业务表。建议升级前在正常停止服务后备份数据目录及相关宿主会话。

**Markdown 不替代完整模型会话备份，也不包含宿主 API key。** 三份设定会参与模型请求；“本地文件”不等于模型永远看不到。日志和 Todo 默认只保存，显式附带或启用相应上下文/回顾功能后才发送。

## 应用前台时长

设置中的“记录应用前台使用时长”默认关闭。启用后只记录应用名称、bundle ID、UTC 起止时刻和秒数，不采集截图、窗口标题、网页地址、文档内容、键盘事件或输入内容。

Apple DeviceActivity 的隐私隔离不提供适合本插件读取并导出全系统 Mac Screen Time 的通用接口。因此本版使用 NSWorkspace、会话与 idle 状态自行统计，**不是导入 Apple 屏幕使用时间，也不保证相同数字**。

- 从开启时刻开始，不恢复过去未采集的时段。
- 睡眠、锁屏、非活动会话不计入；默认超过 60 秒无输入视为闲置。长时间阅读可能因此少计，不能将该值等同于精确工作时长。
- 每 5 秒 heartbeat；超过 10 秒的断档保守留空，不虚构补算。
- JSONL 按 UTC 日期分文件，回顾仍按本机时区的截止点筛选。
- 关闭开关停止；外部把 settings.md 改为关闭后，运行中的插件约 1 秒内同步停止；配置读取失败也停止。
- 服务没运行时不采集。建议按需启用本机后台常驻。

## 每日回顾与记忆建议

**每日回顾**开启后，于机器所在时区每天 05:00 汇总截至该时点的过去 24 小时：Journal、期间新增或状态改变的 Todo，以及已开启采集的应用时长。会向 Harness 当前模型发送有限条原文和时长汇总，可能产生模型费用；不会默认发送全部聊天。

关闭/睡眠错过时间后，恢复时补最近一期，不逐日无限追赶。实际时间范围写入文件；夏令时仍按 UTC 24 小时回溯。已有回顾不自动覆盖，包括你手动修改的版本。无数据明确说明，不杜撰活动或情绪，不给一天打分；失败有状态与有限重试。此功能不会唤醒关机的电脑。

**记忆建议**开启后，从最近有限条用户对话提取有原文依据的事实/偏好，最多 5 条候选，由你接受或拒绝。不会自动改写 soul/user/system。确认记忆可在允许附带上下文时供对话使用；当前是有界直接选取，不是向量语义记忆库。

## 保持 Claudia 更新

“自动安装正式更新”默认关闭。开启即授权每日本地 06:00 从固定仓库 `iamhej/dsh-claudia` 的**正式 Release**检查新版本；不跟随 main，不安装 prerelease，不接收自定义下载地址。

下载有 HTTPS、大小、来源、SHA-256、tar 路径、关键入口、包名版本、Node/peer 兼容检查；禁止安装生命周期脚本。先备份插件与 profile 配置，安装失败恢复旧版本。业务 MD 和凭据不参与覆盖。pnpm 缺失时明确失败，不偷偷在线安装依赖。

安装成功后先显示等待重启。通过本插件 supervisor 启动时，会等待 Claudia 空闲；**宿主仍有其他活跃会话时保守不重启**。启动器请求停机握手后重启自己的宿主进程，以 appReady 和新版本 health 确认生效；失败尝试恢复旧插件一次，不无限循环。直接 `dsh web` 启动时需手动重启。

自动更新信任仓库发布者；哈希保证下载完整性，不等同于独立签名审计。请只在愿意持续信任本项目发布时开启。

## macOS 后台常驻

设置中独立确认后注册当前用户 LaunchAgent，不需要 root。服务标签根据 home 区分，登录时运行，无需 WorkBuddy。已有前台同 home 实例时等待其退出后接管，不杀现有进程。关闭时只停用本插件注册的服务。

后台进程需要可用的同一 Node、dsh 和 pnpm 路径。跨机器复制 `.plist` 不构成安装。此功能不会自动打开采集、回顾或更新开关；这些授权仍独立。

## 模型、连接器与权限

设置/能力页显示真实宿主模型状态。配置模型、凭据或 MCP 请打开 Harness 处理；本版没有虚构连接器清单或并不存在的设置深链接。

Claudia 对话和维护 Agent 没有通用工具执行权限，不关闭其他宿主会话的工具。插件加载期间，会对已登记的 Claudia 会话从宿主入口恢复时重新施加限制；卸载插件后不要从其他入口继续这些会话并期待插件仍能实施权限限制。`system.md` 不能启用系统权限。

只监听 `127.0.0.1`，校验 Host/Origin/CSRF，记录不是加密数据库。不要反向代理公开，不用于多用户共享主机。删除记录无法撤回提供商已收到的内容或旧会话、备份。插件没有遥测，宿主日志/遥测和提供商行为遵循各自设置。

## 开发验证

```sh
node --test --test-concurrency=1 tests/*.test.mjs
npm pack --dry-run
```

`tests/native-host.mjs` 使用真实 Harness + 本机模拟模型，须先安装到独立 `TEST_DSH_HOME`；它会写入合成配置与凭据，**绝不能指向日常 home**。`DSH_BIN` 可指定 CLI JS 入口。Swift 可选编译测试只执行 `--check`，不读取真实使用记录。模拟模型和模拟安装测试不等于所有提供商、所有 macOS 版本均已验证。

源仓库不含用户记录、真实凭据、宿主配置、编译产物或依赖目录。安装包使用显式 files 白名单。

## License

MIT。Harness 与各依赖保留各自许可证。
