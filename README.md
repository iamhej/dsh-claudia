# dsh-claudia

**让个人 AI 助手不止是一个聊天框。**

一个运行在 DeepSeek Harness 上的双栏个人助手插件：左侧是持续的对话，右侧是可以随手记录、查看和带回对话的卡片空间。

默认叫 **Claudia**，也可以在左侧顶部的齿轮设置里，给她起一个自己的名字。

> 当前版本：**0.2.1 · 早期预览版**。面向单用户、本机使用，优先验证 macOS。交互受到 Today 启发；本项目与 Today、DeepSeek 均无官方隶属或背书关系。

## 它是什么

Claudia 是一个 **Harness 原生 Bundle 插件**，不是另一套独立的 Agent 系统。

- **左侧持续对话**：支持流式回复、取消回复，以及恢复本插件已有的会话。
- **右侧卡片空间**：Today、Journal、记忆与能力标签；切换标签不会丢失左侧对话。
- **Journal 快捷记录**：随手记下发生了什么，保存时不必让 AI 回复。需要讨论时，再把记录带入对话。
- **手动确认的记忆**：保存、查看和删除希望助手记住的内容；是否自动附带到模型请求中由你决定。
- **可配置名字**：界面与本插件的对话人格同步使用新名字，更名不清空历史。

底层复用 Harness 的模型适配、Agent 执行循环、会话持久化和上下文压缩。插件只增加交互界面、业务数据与受限的个人对话 Agent。

**不依赖 WorkBuddy，不启动第二个 Harness，不修改 Harness 核心源码，也不要求重复输入 API key。**

## 先了解当前边界

下面这些能力**尚未实现**，不要把它当作已经具备全部能力的个人助理：

- 自动提取、合并和更新长期记忆。
- 定时日总结、后台主动任务。
- macOS 屏幕使用时长采集或分析。
- 在 Claudia 对话中执行连接器、Shell 或其他模型工具。
- AI 自主生成任意卡片、扩展标签页。
- 独立的 macOS `.app` 安装包。

目前的卡片类型是内置的，能力标签不代表连接器已启用。个人对话的工具执行默认被禁止；限制只作用于本插件的 Agent，不关闭 Harness 其他会话的工具、MCP 或 Skills。

## 安装前提

1. 已安装、可运行的 DeepSeek Harness。
2. Node.js **`^22.19.0 || >=24.0.0`**，需要内置 `node:sqlite`。
3. 启动安装命令的终端中能运行 `pnpm --version`；官方 `dsh plugin` 命令通过 pnpm 安装插件。
4. 在准备运行插件的**同一个 Harness home** 中，已配置提供商凭据并选择默认模型。

### 已验证的环境

| 项目 | 版本 / 范围 |
| --- | --- |
| 操作系统 | macOS，Apple Silicon |
| Node.js | 22.22.2 |
| pnpm | 10.17.1 |
| Harness CLI | 0.1.5-rc.1 |
| Harness Agent / LLM / System Prompt 模块 | 实际解析为 0.1.5-rc.2 |

Harness 仍处于预览阶段，接口变化可能破坏兼容性。仅固定 CLI 版本不等于固定其依赖树；其他版本和平台需要另行验证。

## 安装与启动

### 方式一：Release 安装包（推荐）

从本仓库 Releases 下载 `dsh-claudia-0.2.1.tgz`，然后在你平时使用 Harness 的环境中执行：

```sh
# 将路径替换为实际下载位置
pnpm --version
dsh plugin --profile web add /absolute/path/to/dsh-claudia-0.2.1.tgz

# 如果 Harness 已经运行，先正常退出，再重新启动
dsh web
```

插件默认地址为 **http://127.0.0.1:4317**。Harness 原界面仍然保留。macOS 默认尝试打开插件页面；使用 `dsh web --no-open` 可禁止自动打开。

### 方式二：GitHub 源码 / fork

从发布标签安装：

```sh
dsh plugin --profile web add "git+https://github.com/iamhej/dsh-claudia.git#v0.2.1"
dsh web
```

仓库：https://github.com/iamhej/dsh-claudia 。安装自己的 fork 时，替换仓库地址。源码包含运行入口与静态资源，不需要安装时构建。需要严格可复现时，将标签替换为对应的完整提交号，而不是跟随可能变化的分支。

仓库链接本身不是自动安装机制。你可以把链接交给具备本机安装能力的助手，明确要求安装并批准操作；也可以自己执行上面的命令。

**尚未发布到 npm**，请勿假定 `dsh plugin add dsh-claudia` 已经可用。

### 已经配置过 Harness？

无需在 Claudia 再填一遍 key，但必须使用正确的 home 与 profile：

- 如果平时设置了 `DSH_HOME`，安装和启动时保留同一个值。不要另建空 home 后期待原来的凭据自动出现。
- 上述命令安装到 `web` profile，由 `dsh web` 加载。其他自定义 profile 必须包含所需的 Web 和 Agent 服务，并在安装、启动时使用同一个 profile。
- **不要把示例直接改成 `--profile desktop`**。实测 CLI 将 `desktop` 保留给 Electron 桌面程序并拒绝直接操作；本项目尚未验证桌面程序内的安装流程。
- 本插件使用自己的会话，不接管 Harness 其他对话，也不自动导入它们的历史。

## 开始使用

1. 在左侧正常聊天。插件使用 Harness 当前选择的默认模型。
2. 点击齿轮修改名字，留空则恢复为 Claudia。
3. 在右侧 **Journal** 中记录事件；保存本身不会发起模型请求。
4. 想讨论某条记录时，点击“带入对话”，再从左侧主动发送。
5. 在 **记忆** 中手动保存长期信息；按需开启自动附带上下文。

模型路由可以解析，不等于 API key 已经验证。只有成功收到模型正文后，界面才会标记该路由已验证；鉴权或模型配置有问题时，请返回 Harness 检查设置。

## 模型与凭据

- 默认模型来自宿主 `agentDefaultModel.currentSelection()`。
- 调用由宿主 Agent 与模型适配器完成，凭据由 Harness 自己解析。
- 插件不读取、复制、保存或向浏览器返回 API key，也没有另一套 Base URL / key 输入框。
- 支持哪些提供商与模型，取决于 Harness 已配置的 adapter；不硬编码为 DeepSeek 官方模型。
- 模型调用仍可能产生提供商费用；本地运行不等于离线推理。

## 数据、上下文与隐私

### 数据放在哪里

Journal、手动记忆、界面显示的消息和昵称默认保存在：

```text
<DSH_HOME>/claudia/claudia.sqlite
```

真正的模型会话由宿主 Harness 另行持久化。**只备份 SQLite 不足以完整恢复模型上下文**；备份应同时覆盖相关宿主会话数据，并在服务正常退出后进行。

名字最多 40 个 UTF-16 码元，与浏览器输入框的 `maxlength` 一致；空白恢复默认，禁止换行、控制字符和方向控制符。

### 什么时候会发给模型

- Journal 默认只在本机保存。
- 显式“带入对话”的记录，在你发送聊天时附上。
- 开启自动附带上下文后，每次发送有限条日志和记忆**原文**，不是自动摘要。
- 本地上下文包的序列化字符预算为 14,000，显式附件优先；这不是完整对话的 token 上限。

删除本地记录，不能撤回此前已发给提供商或保存在旧会话、备份里的副本。

### 安全范围

- 数据库不是加密数据库，建议使用系统账户隔离与磁盘加密。
- HTTP 服务仅监听 `127.0.0.1`，校验 Host、Origin 与 CSRF token。
- 这不是针对本机恶意进程的安全隔离层，也不适合多人共享服务器。
- **不要将本地服务通过反向代理或端口映射公开到互联网。**
- 插件不外发遥测；宿主日志、遥测与模型服务的数据处理遵循各自设置。插件界面的错误摘要不等于宿主日志也已脱敏。

## 可选配置与常见问题

在当前 profile 的 `cordis.patch.yml` 中添加或合并以下配置，保留其他已有设置：

```yaml
- id: dsh-claudia
  config:
    port: 4317
    openBrowser: false
```

**端口被占用怎么办？**

插件不会自动结束占用端口的进程。可以正常退出你确认不再使用的旧实例，或把插件端口改为其他空闲端口，例如 `4318`。设为 `0` 时由系统选择空闲端口，实际地址会打印在宿主日志中。修改后重启 Harness。

**已有 Journal 数据怎么办？**

可用 `dataDir` 指定已有业务数据库目录，必须是绝对路径。插件不会自动搬移私人数据。跨 Harness home 切换时，仅指向旧 SQLite 并不会迁移宿主模型会话，不应把它当作完整历史迁移方案。

**安装提示缺少 DSH peerDependencies？**

实测环境中，这些模块由 Harness 的宿主模块解析回退提供，已验证可以实际加载。不要仅因警告就安装第二份 Harness。若真正启动时报缺模块，再检查宿主版本及安装完整性。

**为什么连上 Harness 还不能聊天？**

连接宿主、解析模型配置、通过提供商鉴权是不同阶段。请检查同一个 home 中的模型选择与凭据，以及提供商服务可用性；Claudia 不会要求你把 key 粘贴到聊天框。

## 开发与验证

运行存储/API 测试和检查打包清单：

```sh
node --test tests/store.test.mjs tests/native-api.test.mjs
npm pack --dry-run
```

原生集成测试位于 `tests/native-host.mjs`。先在**独立测试 home** 安装插件，再设置 `TEST_DSH_HOME` 运行；`DSH_BIN` 可指定 dsh 的 JS 入口，不设则从 PATH 调用 dsh。

**集成测试会写入合成 settings 与 credentials，绝不能将 `TEST_DSH_HOME` 指向日常使用的 home。**

当前验证范围：

- 24 项存储 / API 测试通过。
- 真实 Harness + 本机模拟模型：原生加载、同进程运行、宿主凭据与默认模型继承、昵称人格、流式输出、多轮对话、重启恢复、取消和零工具暴露。
- 浏览器验证：昵称修改及刷新恢复、Journal 操作、中文输入与窄屏布局。

**模拟模型测试通过，不代表真实付费模型的鉴权、兼容性与回答质量已验收。**

发布仅包含插件源码、静态资源、测试和说明。不要上传个人 `data/`、`runtime-home/`、`.credentials.yaml`、`.env`、宿主会话或 `node_modules/`。包内容使用 `package.json` 的 `files` 白名单控制；测试文件保留在源码仓库中，不在运行安装包中。

## License

MIT。DeepSeek Harness 及其依赖各自遵循上游许可证。项目名称、截图和素材不表示获得 Today 或 DeepSeek 官方背书。
