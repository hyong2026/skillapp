# GUI（图形控制台）

> 前提：单实例、单用户或可信内网、单个 `lark-cli` 身份；文件系统仍是运行状态的唯一真相。
> 目标：不敲命令也能走完 `装载 → 分析 → 映射 → 执行 → 查看结果`。
> HTTP 细节见 [api.md](api.md)，执行语义见 [run.md](run.md)，模块与落盘见 [architecture.md](architecture.md)。

## 定位

图形控制台是 SkillApp 的控制台，**不是第二个执行引擎**：CLI、HTTP、测试与控制台共用 `src/core/` 里的同一份业务逻辑。

分析由 [`analyze-skill-io`](../.agents/skills/analyze-skill-io/) 完成。点击 `Analyze` 后服务端调用本地分析器（默认 `codex exec`）生成 Mapping，默认低推理强度；可用 `SKILLAPP_ANALYZE_MODEL`、`SKILLAPP_ANALYZE_REASONING_EFFORT` 调整，见 [cli.md](cli.md#环境变量)。

### 成功标准

- 用户不执行 CLI，也能完成一次 Skill 初始化并生成 Template。
- 所有长任务都有持久状态、可订阅进度、可取消；刷新页面能恢复 Loading 状态。
- 同一资源不会被不安全的并发操作同时修改。
- CLI 仍然可用，且与图形界面共用核心逻辑。

## 启动

```bash
cp .env.example .env                       # 首次运行
node src/server/index.js --port 4173       # 本机访问可省略 --token
# 打开 http://127.0.0.1:4173
```

本机访问时令牌可省略；监听非本机地址时必须设置 `--token`（或 `SKILLAPP_WEB_TOKEN`），或显式 `--insecure`。鉴权支持 Basic Auth 与 Bearer token。

## 导航与页面

左侧固定导航：**Skills / Templates / Runs / Operations / Settings**，默认落在 `#skills`（没有 Home 页）。窄屏（≤720px）时导航折叠成右上角 ☰ 的浮层菜单。

### Skills

- 列表：`Skill Name / Status / Loaded / Source`。
- `Load` 打开弹框，填 Skill Source 绝对路径；目录名自动作为 ref，默认完整导入，完成后直接进入详情页（不自动分析）。
- 详情面包屑 `Skills / <Skill Name>`；Summary 展示 Status、Fingerprint、Loaded、Source、Description（装载时从 `SKILL.md` frontmatter 读取），下面是 `Mapping Configuration` 面板。
- Skill 状态：`Unanalyzed / Analyzing / Ready / Stale / Unverified / Invalid`。
- `Mapping Configuration` 默认展示结构化 Inputs / Outputs，`JSON` 开关看原文。
  - 行首勾选框决定该列是否参与映射：取消勾选 = 不建列、不读取、不回写，整行退成次要色；必填输入的勾选框默认勾上且不可改。
  - 列名、勾选、排序都是**即时保存、不重绘页面**（只重建这张表，也不弹提示）；但要**重新执行一次 `Mapping`** 才会写进 Template。
- 右上角动作：`Analyze / Re-analyze`（持久化任务，刷新后仍显示 Loading）、`Mapping`（填 Feishu Base URL，启动 Mapping 任务）、`Unload`（弹框确认后删除本地副本、Mapping、Template 与关联 Run；飞书列不删）。

### Templates

- 列表：`Template Name / Template ID / IO / Last Run / Created`；`Template Name` 是文件名 `<ref>-<目标指纹>` 且带链接（链接锚点用 `template_id`）。
- 右上角 `Show archived`（默认不勾）：勾上后连归档的一起列出，归档行带 `Archived` 徽标。
- 详情：面包屑 `Templates`，标题就是 Template Name；Summary 展示 Template ID、Skill Name、Skill Hash、Feishu Base URL、Created，归档后多一行 `Archived` 徽标。
- `Template Definition` 展示完整 Inputs / Outputs 映射，`JSON` 开关看完整 Template JSON。
- 右上角动作：`Preview`、`Run`（`All Rows` 勾选框决定 `all` / `incremental`）、`Archive` / `Unarchive`。
  - `Preview` 是 dry-run，弹窗反馈触发方式、表内行数、本次会处理的行数、目标表链接，底部一句英文提示说明"不执行、不回写、不产生 Run"；失败（如飞书未授权）也在弹窗里给出可操作提示。
  - 归档 = 冻结：文件保留、从列表消失、不能跑；解冻即恢复。两者都写进 Operations。

### Runs

- 列表：`Run ID / Status / Template Name / Trigger / Succeeded / Total / Started`。
- 详情：Summary（Status、Template Name、Trigger、Progress、Started/Finished、Succeeded/Failed、Error、Work Hash）、`Run Items` 表、Live Output。
- RunItem 详情：状态、阶段、耗时、错误、Input Hash、Artifacts 卡片与 stdout/stderr 日志。
- 运行中的 Run 可 `Cancel`；终态且有失败行时可 `Retry`（等价于再跑一次增量，产生新 Run）。

### Operations

- 统一列出所有异步操作：`load-skill / analyze-skill / map-table / unload-skill / archive-template / unarchive-template / run-template`。
- 列表：`Operation ID / Status / Type / Subject / Started / Duration`；Subject 带类型前缀图标，可跳到对应 Skill / Template / Run。
- 详情：Summary 加该操作的原始记录 JSON。

### Settings

- `Runtime`：App URL、Repo Root、Node Version（只读）。
- `Configuration`：目前是占位面板。分析器白名单（`SKILLAPP_ANALYZE_COMMAND / _MODEL / _REASONING_EFFORT / _TIMEOUT_MS`）的读写接口已经就绪（`GET/PUT /api/settings`，见 [api.md](api.md#put-apisettings)），界面后续接。
- 应用重启与飞书授权初始化**尚未实现**：授权走 `lark-cli auth login`。

## 消息区（Messages）

侧边栏底部固定一块消息区，是"所有异步操作"的实时集合：

- 最多显示 3 条（进行中优先），有任务时才出现；窄屏隐藏。
- 每条：操作类型 + 状态徽标 + 对象名（**优先显示 Template Name / Skill Name，不显示 ID**）。
- 进行中的可以 `Cancel`；跑完的可以整行点进对应详情页（Run / Template / Skill），或点 ✕ 手工关掉（只影响本机这块面板，Operations 页的记录不动，关闭状态存 localStorage）。
- 数据来自全局 SSE `GET /api/operations/events`：连上先给一次全量快照，之后逐条推摘要，**不轮询**；断线每 2 秒重连（重连会再拿一次快照），只有在流不可用且手上还没数据时才兜底拉一次列表。

## UI 约定

- 静态文案统一英文；表头、字段名与分析面板标题首字母大写（不强制全大写）。
- 表头、Summary 字段名、弹框字段名共用一套样式与字号（10px / 600 / 等宽，次要色）。
- 所有弹框都是应用内 `<dialog>`，不用浏览器原生 `confirm`：输入弹框、信息弹框（Preview）、确认弹框（Unload / Archive / 全量 Run）。确认弹框支持 Esc / Cancel 放弃，危险动作的确认按钮为红色，按钮返回 `OK`。
- 列表页（Skills / Templates / Runs / Operations）**每页 10 条、最新在前**，底部 `Page x / y` + 带箭头的 `Prev / Next`（只有一页时不显示翻页条）；页号按列表记忆（sessionStorage），切页面/刷新仍在原页。表头 `sticky` 锁在列表顶部。
- 表格容器自己纵向滚动（`max-height: 70vh`），滚动时表头不动。
- 日期时间统一 `YYYY-MM-DD HH:mm:ss`。
- JSON / stdout / stderr 用代码块展示并带行号（行号在行首，长行换行时续行悬挂缩进，不出现横向滚动）。
- 默认路由 `#skills`；列表与 Summary 不放无意义的统计块。

## 前端结构

零依赖 ES 模块（`src/web/`）：

| 位置 | 内容 |
|---|---|
| `app.js` | 入口：装导航图标、菜单、消息区，然后交给路由 |
| `index.html` / `styles.css` | 静态骨架与全部样式（含字体与字号规范） |
| `lib/router.js` | Hash 路由（`#list` / `#list/:id` / `#runs/:run/:record`） |
| `lib/components.js` | 面板、表格、分页表、可编辑映射表等共用件 |
| `lib/api.js` | 请求封装、SSE 读取、操作订阅 |
| `lib/messages.js` | 侧边栏消息区（全局操作流） |
| `lib/shell.js` | 页面骨架（视图头固定在滚动区之外）、窄屏 ☰ 菜单 |
| `lib/dialogs.js` | 输入 / 信息 / 确认三类弹框 |
| `lib/format.js`、`lib/highlight.js`、`lib/links.js`、`lib/dom.js` | 格式化、JSON 高亮、链接与 DOM 小工具 |
| `views/*.js` | 一页一个文件（skills / templates / runs / run-item / operations / settings） |
