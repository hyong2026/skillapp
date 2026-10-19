# GUI（图形控制台）

> 前提：单实例、单用户或可信内网、单个 `lark-cli` 身份；文件系统仍是运行状态的唯一真相。
> 目标：不敲命令也能走完 `装载 → 分析 → 绑定 → 执行 → 查看结果`。
> HTTP 细节见 [api.md](api.md)，执行语义见 [run.md](run.md)，模块与落盘见 [architecture.md](architecture.md)。

## 定位

图形控制台是 SkillApp 的控制台，**不是第二个执行引擎**：CLI、HTTP、测试与控制台共用 `src/core/` 里的同一份业务逻辑。

分析由 [`skill-analyzer`](../.agents/skills/skill-analyzer/) 完成。点击 `Analyze` 后服务端调用本地分析器（默认 `codex exec`）生成 Mapping，默认低推理强度；可用 `SKILLAPP_ANALYZE_MODEL`、`SKILLAPP_ANALYZE_REASONING_EFFORT` 调整，见 [cli.md](cli.md#环境变量)。

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

左侧固定导航：**Home / Skills / Templates / Runs / Operations / Settings**，默认落在 `#home`。窄屏（≤720px）时导航折叠成右上角 ☰ 的浮层菜单。

### Home

四步流程走完一次「装载 → 分析 → 绑定 → 执行」，每步做完自动进入下一步；Run 一发起就跳去 Run 详情页（那里有实时结果与日志）。
**状态只活在这次访问里**：刷新或切走就从第一步重来，不保留"当前 Skill"。第一步只能填路径（不支持拖拽文件夹）。

### Skills

- 列表：`Skill Name / Status / Loaded / Source`。
- `Load` 打开弹框，填 Skill Source 绝对路径；目录名自动作为 ref，默认完整导入，完成后直接进入详情页（不自动分析）。
- 详情面包屑 `Skills / <Skill Name>`；Summary 展示 Status、Fingerprint、Loaded、Source、Description（装载时从 `SKILL.md` frontmatter 读取），下面是 `IO Schema` 面板。
- Skill 状态：`Unanalyzed / Analyzing / Ready / Stale / Unverified / Invalid`。
- `IO Schema` 默认展示结构化 Inputs / Outputs（分析产出的 IO 契约，还没绑定到表），`JSON` 开关看原文。
  - 行首勾选框决定该列是否参与映射：取消勾选 = 不建列、不读取、不回写，整行退成次要色；必填输入的勾选框默认勾上且不可改。
  - Inputs 把 Required 与 Default 合成一列显示（`Required [Default]`，如 `Yes` / `No [cute]`）——只是界面合并，存储上仍是两个字段；Outputs 不显示 Precision（仍保留在 JSON 里）。
  - 列名、勾选、排序都是**即时保存、不重绘页面**（只重建这张表，也不弹提示）；但要**重新执行一次 `Bind Table`** 才会写进 Template。
- 右上角动作：`Analyze / Re-analyze`（持久化任务，刷新后仍显示 Loading）、`Bind Table`（填 Lark Base URL，启动绑定任务）、`Unload`（弹框确认后删除本地副本、Mapping、Template 与关联 Run；飞书列不删）。

### Templates

- 列表：`Template Name / Template ID / IO / Last Run / Created`；`Template Name` 是文件名 `<Skill Name>-<目标指纹>` 且带链接（链接锚点用 `template_id`）。
- 右上角 `Show Archived`（默认不勾）：勾上后连归档的一起列出，归档行带 `Archived` 徽标。
- 详情：面包屑 `Templates`，标题就是 Template Name；Summary 展示 Template ID、Skill Name、Skill Hash、Lark Base URL、Created，归档后多一行 `Archived` 徽标。
- `Template Definition` 展示已映射的 Inputs / Outputs（与表里的列一一对应，列宽与 IO Schema 同一套规则，同样把 Required / Default 合成一列、不显示 Precision），`JSON` 开关看完整 Template JSON。
- 右上角动作：`Execute`、`Archive` / `Unarchive`。
  - `Execute` 先做一次 dry-run 预览。弹框固定列出 `Lark Base URL / Trigger / Rows in table / Rows to process`（未加载出来的值是 `—`；`Lark Base URL` 打开时就按 Target 填好，不依赖预览、勾选 All Rows 也不会刷新，长链接整段换行）；**`All Rows` 勾选框在弹框左下角**，切换即重新预览、弹框高度不变，再点弹框里的 `Execute` 才真正提交。失败（如飞书未授权）也在弹框里给出可操作提示。没有 Preview 按钮——预览已经成为 `Execute` 的第一步。
  - 没有要跑的行时，`Rows to process` 会是 `0`，弹框里的 `Execute` 也会被禁用。
  - Template 不可跑时（已归档、Skill 指纹不符、`cmd` 模板写错、位置参数用了未映射的列），**预览阶段就在弹框里说清楚**，点 `Execute` 也不会产生记录——不会先建一条 Failed 的 Run 让人对着空白明细猜。
  - 归档 = 冻结：文件保留、从列表消失、不能跑；解冻即恢复。两者都写进 Operations。

### Runs

- 列表：`Run ID / Status / Template Name / Trigger / Succeeded / Total / Started`；右上角 `Show Deleted` 勾选框（逻辑删除的 Run 默认不列，勾上才出现，行内带 `Deleted` 徽标）与 `All Triggers` 下拉（服务端过滤）。
- 详情：Summary（Status、Template Name、Trigger、Progress、Started/Finished、Succeeded/Failed、Work Hash）；有错误时多一块 `Error` 面板（按日志渲染：带行号、整段是 JSON 才高亮；Run 半路失败时会补一句影响了几行），`Run Items` 表（Duration 同样格式化）。日志一律点进 Run Item 看，这一页不重复展示。
- Run Item 详情：Summary（Status、Stage、Duration、`Resumed From`（续跑时才有）、Input Hash）+ 独立的 `Error` 面板 + Artifacts 卡片 + 日志面板。`Duration` 走同一个 `formatDuration`（`404 ms` / `1.5 s` / `1m 8s` / `2m`，整分钟不写秒），Runs、Operations、Run Item 共用。
- Run Item 的日志：`Live Logs` / `Stdout Logs` / `Stderr Logs` **一行一个**，每块**固定高度、内部滚动**（打开时都定位到最后一行；滚到头再滚会把页面接着滚下去），**只显示真的有数据的那些**，面板**按需出现**——prompt 型通常给 `Live Logs`，脚本型给 `Stdout Logs` / `Stderr Logs`。只要这一行还活跃，页面就订阅这个 Run 的流：三块日志都**按块追加**（**贴底才跟随**：停在末尾就自动跟到底，往上翻看历史则不动），Summary 的 `Status` / `Stage` / `Duration` 跟着事件走；这一行跑完（或整个 Run 收尾）再按磁盘重画一次，`Error` 与 `Artifacts` 一并出来。
- 运行中的 Run 可 `Cancel`；终态且有失败行时可 `Retry`（等价于再跑一次增量，产生新 Run；**上次 Skill 已跑完、只是回写失败的行会断点续跑**，复用产物不再重跑，见 [run.md](run.md#断点续跑)）；终态可 `Delete`（确认弹框 → `delete-run` 操作，**逻辑删除**：只打 `deleted_at`，文件/日志/产物都留着，所以 Message 与 Operations 里的链接照样打得开，详情页显示 `Deleted` 徽标且不再给 Delete 按钮；没有反向操作，也不释放磁盘）。跑着的 Run 要先取消。
- 详情页靠 SSE 实时重画：重画**不重播入场动画**（否则每次事件都闪一下 2px/透明度，看着像抖动），日志按块推到页面时**合并成 120ms 一次重画**。

### Operations

- 统一列出所有异步操作：`load-skill / analyze-skill / bind-table / unload-skill / archive-template / unarchive-template / execute-template / delete-run`（**操作类型名沿用 `analyze-skill`**——它是 API 与历史记录的一部分；对应的 Skill 叫 `skill-analyzer`）。
- 列表：`Operation ID / Status / Type / Subject / Started / Duration`；Subject 带类型前缀图标，可跳到对应 Skill / Template / Run。
- 详情：Summary 加该操作的原始记录 JSON。

### Settings

- `Appearance`：`Theme` 分段控件 `Dark | Light`，默认 Dark。切换即时生效，只存本浏览器（`localStorage`），不进服务端配置；首屏由独立的 `theme-boot.js` 先落主题（CSP 只允许 `script-src 'self'`，所以不用内联脚本），不闪。浅色主题在 `styles.css` 的 `:root[data-theme="light"]` 里只覆盖同名变量，logo 也随之切到 `logo-light.svg`。
- `Pagination`：`Page Size` 数字输入（1–200，默认 10），**移开焦点（或回车）自动保存**到 `.env`，列表下次取页即时生效；值没变不发请求，保存成功不弹提示，失败或填入非法值就退回原值。
- `Runtime`：App URL、Repo Root、Node Version（只读）。
- `.env` 白名单（清单见 [cli.md](cli.md#环境变量)）的读写接口已经就绪（`GET/PUT /api/settings`，见 [api.md](api.md#put-apisettings)），界面上目前只有 `Page Size`。`SKILLAPP_IMAGE_API_KEY` 与 `SKILLAPP_WEB_TOKEN` 一样只显示"已设置"，密钥本身不回显。
- 应用重启与飞书授权初始化**尚未实现**：授权走 `lark-cli auth login`。

## 消息区（Messages）

侧边栏底部固定一块消息区，是"所有异步操作"的实时集合：

- **只露出最近 3 条**（进行中优先），同一块区域里其余消息用垂直滚动条看；有任务时才出现；窄屏隐藏。
- 鼠标移入（或键盘焦点进入）消息区时，标题右侧出现 `Clear`：一键清空当前所有消息（和 ✕ 一样只影响本机 localStorage，Operations 记录不动；之后新来的消息照常出现）。
- 每条：操作类型 + 状态徽标 + 对象名（**优先显示 Template Name / Skill Name，不显示 ID**）。
- 进行中的可以 `Cancel`；跑完的可以整行点进对应详情页（Run / Template / Skill），或点 ✕ 手工关掉（只影响本机这块面板，Operations 页的记录不动，关闭状态存 localStorage）。
- 数据来自全局 SSE `GET /api/operations/events`：连上先给一次全量快照，之后逐条推摘要，**不轮询**；断线每 2 秒重连（重连会再拿一次快照），只有在流不可用且手上还没数据时才兜底拉一次列表。

## UI 约定

- 静态文案统一英文；表头、字段名与分析面板标题首字母大写（不强制全大写）；导航、消息区标题、列表页 / Home / Settings 的标题、筛选下拉的分组名统一全大写（导航与分组名用复数，两边文案一致）。
- 表头、Summary 字段名、弹框字段名共用一套样式与字号（10px / 600 / 等宽，次要色）。
- 所有弹框都是应用内 `<dialog>`，不用浏览器原生 `confirm`：输入弹框（Load / Bind）、确认弹框（Unload / Archive / Delete / 全量 Execute）、提示弹框（页面级失败，只有一个 `OK`）、Execute 弹框（预览 + 提交）。确认弹框支持 Esc / Cancel 放弃，危险动作的确认按钮为红色。
- 页面级失败（路由不存在 / 详情读不出来）：**不把错误嵌在页面里**（那样顶部会留着上一页的标题和按钮），而是清空顶部与内容、弹一个只有 `OK` 的提示框，关掉后回到上一级；没有 `Retry` —— 东西真的不在了时重试没有意义。
- 列表页（Skills / Templates / Runs / Operations）**服务端分页、最新在前**：每次只取当前页，底部固定一条翻页栏 —— 左侧 `Total X | Size Y`（竖线分隔），右侧 `Page x / y` + 带箭头的 `Prev / Next`（只有一页时箭头禁用，页码仍是 `1 / 1`），翻页时保留旧数据、箭头禁用，表格不重排。每页条数由 `SKILLAPP_PAGE_SIZE` 决定（默认 10，Settings 里可改）。页号只在当前模块内记忆，切到别的模块或刷新都回到第 1 页；Operations 的 Type、Runs 的 Trigger 过滤也在服务端（`?type=` / `?trigger=`），Runs 的 `Show Deleted` 走 `?include_deleted=1`。表头 `sticky` 锁在列表顶部。
- 只有列表页的表格容器自己纵向滚动，滚动时表头不动；其余表格跟随页面滚动。列表页的面板按**页面剩余高度**自适应（高度跟着窗口走，不再写死 `70vh`），翻页条钉在面板底部。
- 日期时间统一 `YYYY-MM-DD HH:mm:ss`。
- JSON / stdout / stderr 用代码块展示并带行号（行号在行首，长行换行时续行悬挂缩进，不出现横向滚动）。
- 默认路由 `#home`；列表与 Summary 不放无意义的统计块。

## 前端结构

零依赖 ES 模块（`src/web/`）：

| 位置 | 内容 |
|---|---|
| `app.js` | 入口：装导航图标、菜单、消息区，然后交给路由 |
| `index.html` / `styles.css` | 静态骨架与全部样式（含字体与字号规范） |
| `lib/router.js` | Hash 路由（`#list` / `#list/:id` / `#runs/:run/:record`） |
| `lib/components.js` | 面板、表格、分页表、可编辑 IO Schema 表等共用件 |
| `lib/api.js` | 请求封装、SSE 读取、操作订阅 |
| `lib/messages.js` | 侧边栏消息区（全局操作流） |
| `lib/theme.js`、`theme-boot.js` | 主题 Dark / Light：运行时切换与首屏防闪（`logo-light.svg` 是浅色 logo） |
| `lib/shell.js` | 页面骨架（视图头固定在滚动区之外）、窄屏 ☰ 菜单 |
| `lib/dialogs.js` | 输入 / 确认 / 提示三类弹框 + Execute 弹框（预览与提交） |
| `lib/format.js`、`lib/highlight.js`、`lib/links.js`、`lib/dom.js` | 格式化、JSON 高亮、链接与 DOM 小工具 |
| `views/*.js` | 一页一个文件（home / skills / templates / runs / run-item / operations / settings） |
