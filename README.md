# SkillApp

**一个容器**：装载 Skill，把 Skill 的 IO 映射到飞书多维表格，并具备执行能力。

三步。用户只需要给两样东西：**一个 Skill 路径**，**一个表格链接**。

| # | 步骤 | 用户给什么 | 得到什么 |
|---|---|---|---|
| 1 | **装载 Load** | Skill 路径 | 复制进 SkillApp + 一份 **Mapping** |
| 2 | **映射 Map** | 表格链接 | 表格列 + Template |
| 3 | **执行 Run** | —— | 回写的结果 |

前两步合称「**初始化**」——把一个 Skill 变成可运行的 Template。（图形界面把第一步拆成 `Load` 与 `Analyze` 两个按钮。）

**闸门在装载与映射之间**：装载只复制并生成 Mapping，不碰表格；映射会改表格结构，按 Mapping 中的默认建议执行。

## 快速开始

三种入口，任选其一（业务逻辑是同一份，见 [docs/architecture.md](docs/architecture.md)）。

**1. 图形控制台（推荐）**

```bash
cp .env.example .env                         # 首次运行，按需填写
node src/server/index.js --port 4173         # 本机访问可省略 --token
# 浏览器打开 http://127.0.0.1:4173
```

页面上依次点：`Load`（填 Skill 路径）→ `Analyze` → `Mapping`（贴表格链接）→ `Preview` → `Run`。
细节见 [docs/gui.md](docs/gui.md)。

**2. 命令行**

```bash
# 装载 = 复制（目录名就是 Skill Name）
node src/cli/load-skill.js /path/to/skill
# 分析：由 Agent 用 analyze-skill-io 完成 → .data/mappings/<Skill Name>.mapping.json

# 映射：对齐列、设列顺序、写 Template，并自动自检
node src/cli/map-table.js --ref <ref> --url '<表格链接>'

# 执行：读行 → 跑 Skill → 回写
node src/cli/run-template.js .data/templates/<Skill Name>-<目标指纹>.template.json --incremental
```

`--incremental` 只跑**工作版本或当前输入与最近一次成功运行不一致**的行（没跑过、上次失败、Skill/Mapping/目标变过、或输入变了），可安全重复执行。
完整参数见 [docs/cli.md](docs/cli.md)。

**3. 让 Agent 代劳**

`.agents/skills/` 里的项目级 Skill 会接住这些话：

| 你说 | Agent 会做 |
|---|---|
| 「装载：/path/to/skill」 | 复制进 SkillApp，并分析它的 IO |
| 「映射到这张表：<链接>」 | 建列、设列顺序、出 Template |
| 「执行 / 跑一批」 | 跑 `run-template.js --incremental` |

## 术语

| 词 | 含义 | 落在哪 |
|---|---|---|
| **Skill** | 带 `SKILL.md` 和可执行入口的目录，可能是 Node、也可能是 Python | `.data/skills/<Skill Name>/` |
| **Skill Name** | 装载后的 Skill 名，取源目录最后一段；CLI 参数与 API 路径里写作 `ref` | 到处 |
| **装载 Load** | 复制进内容层 + 固定内容指纹，**不碰表格** | `.data/skills/<Skill Name>/` |
| **分析 Analyze** | 读实现产出 Mapping 草案，由 `analyze-skill-io` 完成 | `.data/mappings/<Skill Name>.mapping.json` |
| **Mapping** | Skill 的 IO 契约：输入 / 输出 / 命令模板（名词；动作是「映射 Map」） | `.data/mappings/<Skill Name>.mapping.json`（草案；生效的那份在 Template 内） |
| **映射 Map** | 把 Mapping 对到某张表的列上：建列、排序、写 Template | `.data/templates/<Skill Name>-<目标指纹>.template.json` |
| **Template** | 可运行的定义：Skill + 内容 hash + 目标表 + 生效 Mapping + limits；可归档（冻结，解冻前不能跑） | 同上 |
| **执行 Run** | 动作：跑一次 Template——读行 → 跑 Skill → 回写（界面按钮 `Run`） | 结果记成一次 Run |
| **Run** | 一次执行的结果记录：`run.json` 里有状态、计数与逐行 Run Item | `.data/runs/<run_id>/` |
| **Run Item** | Run 里的一行（一条记录）的一次执行 | `.data/runs/<run_id>/<record_id>/` |
| **Artifact** | Skill 产出的文件：`attachment` 类型的输出列会回写进表格，本机也留一份 | `runs/<run_id>/<record_id>/artifacts/` |
| **目标指纹** | 目标表（base + table + view）的 sha256 前 8 位，用来区分同名 Skill 的不同目标表 | Template 文件名末尾 |
| **Operation** | 异步操作的记录（Run 也在其中留一份索引） | `.data/operations/<operation_id>/operation.json` |

## 状态

```text
Operation: queued → running → completed | failed | canceled | interrupted
Run:       queued → running → completed | partial | failed | canceled | interrupted
Run Item:  queued → running | succeeded | failed          （dry-run 用 dry-run）
```

服务启动时扫描活动记录，把遗留的 `running` 标成 `interrupted`——不自动续跑。

| trigger | 选行规则 |
|---|---|
| `incremental`（默认） | 没跑过、上次失败、或工作版本 / 输入与最近一次成功运行不一致 |
| `all` | 全表重跑 |

## 边界

> **表格里只存 IO 数据。**
> 映射的目标是飞书多维表格中的**某张表格**（连同它的**视图**，视图决定列顺序与可见性）——不是整个多维表格。
> 表里只有输入列、输出列，外加一个文本主字段作行名。运行状态、Run、Run Item 一律不进表，它们记在 `.data/runs/`。

| 谁管 | 存什么 |
|---|---|
| 某张表格 + 视图 | 用户的输入与输出 |
| `.data/templates/` | Template（内含 Mapping） |
| `.data/runs/` | Run + Run Item + 产物（状态） |

三个词的含义：**Template** 是可运行的定义，它内含一个 **Mapping**——即 Skill 的 IO 与表格列的绑定；`.data/mappings/<Skill Name>.mapping.json` 是 Mapping 的草案，两个步骤之间的中间物。

Mapping 的每个输入 / 输出都可以标 `mapped: false`：**不建列、不读取、不回写**，缺省即参与映射。必填输入不允许未映射——读不到值只能逐行失败。

三条不变量：

1. **Template 里不出现绝对路径。** 只写相对 `.data/` 的 `skills/<Skill Name>` 路径 + 内容 `hash`。
2. **绑定一律用 `field_id`，不用字段名。** 名字随时会被改。
3. **加载时核对，不靠自觉。** 启动时校验 Skill 内容指纹、每个 `field_id` 的存在与类型。

内容层的目录、命名与三条约定见 [`.data/README.md`](.data/README.md)。

已知边界（刻意留着，不是遗漏）完整清单见 [docs/architecture.md](docs/architecture.md#已知边界)，要点：

- 串行执行、没有并发；`--incremental` 会反复捞出失败行；`.data/runs/` 只增不减。
- 一张表（含视图）一份 Template；Template 不进 Git，克隆后无法还原。
- 只支持 **JSON stdout** 的 Skill，且必须有可执行入口。

## 目录

```
skillapp/
├── package.json               仓库元信息与两条脚本；**不声明 type**
├── src/                       引擎代码（ES 模块，零依赖，Node ≥ 22）
│   ├── cli/                   可运行的命令薄壳
│   ├── core/                  内部模块（CLI / HTTP / worker / 测试共用）
│   ├── server/                HTTP API、SSE、任务执行器与 worker
│   └── web/                   零依赖静态控制台（app.js + index.html/styles.css，lib/ + views/）
├── .data/                     内容层 —— 除各目录 README 外不进 Git（见 .data/README.md）
│   ├── skills/<Skill Name>/                      装载进来的 Skill
│   ├── templates/<Skill Name>-<目标指纹>.template.json   Template（内含 Mapping）
│   ├── mappings/<Skill Name>.mapping.json       Mapping 草案（分析产物）
│   ├── operations/<operation_id>/operation.json   异步任务状态
│   └── runs/<run_id>/         Run、Run Item、日志与产物
├── test/                      引擎回归测试（node --test，零依赖）
├── .agents/skills/            项目级 Skill：SkillApp 自己的操作手册
│   ├── skillapp/              操作入口：装载 / 映射 / 执行
│   └── analyze-skill-io/      读 Skill → Mapping（IO 契约）
├── docs/                      文档（见下）
└── README.md
```

**两个 `skills` 不是一回事**，别混：

| 路径 | 是什么 | 进 Git |
|---|---|---|
| `.agents/skills/` | SkillApp 自己的操作手册，给 Agent 用（项目级 Skill） | ✅ |
| `.data/skills/` | 被装载进来、准备执行的 Skill | ❌ 内容 |

`.data/` 的每个子目录各有一份 `README.md` 说明用途，因此克隆后仍能看见结构、知道缺什么。

**跑测试**：在仓库根跑 `node --test`（等价于 `npm test`）。测试用临时目录和假 `lark` 响应覆盖真实 CLI 与执行主逻辑，写操作全落在系统临时目录。

## 文档

| 文档 | 回答什么 |
|---|---|
| 本文件 | 产品是什么、三步流程、怎么开始、术语与状态 |
| [`.data/README.md`](.data/README.md) | 内容层：五个子目录各放什么、命名规则与三条约定（聚合各子目录的 README） |
| [docs/gui.md](docs/gui.md) | 图形控制台：页面、交互、消息区、UI 约定 |
| [docs/cli.md](docs/cli.md) | 四个命令、参数、退出码、`.env` 与分析器配置 |
| [docs/api.md](docs/api.md) | HTTP API：鉴权、端点、SSE、错误格式 |
| [docs/run.md](docs/run.md) | 执行语义：触发与选行、写回、日志与产物、列命名 |
| [docs/architecture.md](docs/architecture.md) | 分层、模块、落盘、锁与生命周期、加固清单、已知边界 |
| [`.agents/skills/`](.agents/skills/) | 交给 Agent 的操作手册（装载 / 分析 / 映射 / 执行） |
