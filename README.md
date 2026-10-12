# SkillApp

**一个容器**：装载 Skill，把 Skill 的 IO 映射到飞书多维表格，并具备执行能力。

三步。用户只需要给两样东西：**一个 Skill 路径**，**一个表格链接**。

| # | 步骤 | 用户给什么 | 得到什么 |
|---|---|---|---|
| 1 | **装载** | Skill 路径 | 复制进 SkillApp + 一份 **IO Schema** |
| 2 | **映射** | 表格链接 | 表格列 + Template |
| 3 | **执行** | —— | 回写的结果 |

前两步合称「**初始化**」——把一个 Skill 变成可运行的 Template。

**闸门在装载与映射之间**：装载只复制并生成 IO Schema，不碰表格；映射会改表格结构，按 Schema 中的默认建议执行。

## 使用

用自然语言驱动即可——`.agents/skills/` 里的项目级 Skill 会接住这些话：

| 你说 | Agent 会做 |
|---|---|
| 「装载：/path/to/skill」 | 复制进 SkillApp，并分析它的 IO |
| 「映射到这张表：<链接>」 | 建列、设列顺序、出 Template |
| 「执行 / 跑一批」 | 跑 `run-template.js --pending` |

也可以直接敲命令：

```bash
# 1. 装载 = 复制 + 分析
node src/cli/load-skill.js /path/to/skill             # 目录名就是 ref
# 分析由 Agent 用 analyze-skill-io 做 → .data/tmp/<ref>.io-schema.json

# 2. 映射：对齐列、设列顺序、写 Template，并自动自检
node src/cli/map-table.js --ref <ref> --url '<表格链接>'  # 契约默认读 .data/tmp/<ref>.io-schema.json

# 3. 执行
node src/cli/run-template.js .data/templates/<ref>.json --pending
```

`--pending` 只跑**工作版本或当前输入与最近一次成功运行不一致**的行（没跑过、上次失败、Skill/Mapping/目标变过、或输入变了），可安全重复执行。

判定只看**最近一次**运行，不看「历史上是否曾经成功」——否则把输入改回旧值会被误判为已完成，而表里的输出其实是另一组输入的产物。

`-h` 查看各命令的完整选项。

## 边界

> **表格里只存 IO 数据。**
> 映射的目标是飞书多维表格中的**某张表格**（连同它的**视图**，视图决定列顺序与可见性）——不是整个多维表格。
> 表里只有输入列、输出列，外加一个文本主字段作行名。运行状态、Run、RunItem 一律不进表，它们记在 `.data/runs/`。

| 谁管 | 存什么 |
|---|---|
| 某张表格 + 视图 | 用户的输入与输出 |
| `.data/templates/` | Template（内含 Mapping） |
| `.data/runs/` | Run + RunItem + 产物（状态） |

三个词的含义：**Template** 是可运行的定义（`.data/templates/<ref>.json`），它内含一个 **Mapping**——即 Skill 的 IO 与表格列的绑定；**io-schema.json** 是 Mapping 的草案，两个步骤之间的中间物。

## 目录

```
skillapp/
├── src/                       引擎代码
│   ├── cli/                   可运行的命令薄壳
│   │   ├── load-skill.js      装载：把 Skill 复制进来并固定版本
│   │   ├── map-table.js       映射：IO 契约 → 表格列 + Template
│   │   ├── run-template.js    执行：读行 → 跑 Skill → 回写
│   │   └── unload-skill.js    卸载：清理本地内容层
│   ├── core/                  内部模块
│   │   ├── paths.js           所有内容目录的唯一路径来源
│   │   ├── lark.js            lark-cli 封装
│   │   ├── load-skill.js      根目录校验、完整复制、原子替换
│   │   ├── io-schema.js       IO Schema 校验、版本与原子保存
│   │   ├── map-table.js       Mapping 计划、plan hash、建列与 Template
│   │   ├── unload-skill.js    卸载影响清单、plan hash 与删除
│   │   ├── run-template.js    Run 核心服务：预检、执行、回写、进度
│   │   └── skill-hash.js      Skill 内容指纹
│   ├── server/                Web 控制台：HTTP API、SSE、任务执行器
│   └── web/                   Web 控制台静态页面
├── .data/                      内容层 —— 除 README 外不进 Git
│   ├── skills/<ref>/          装载进来的 Skill
│   ├── templates/<ref>.json   Template（内含 Mapping）
│   ├── operations/             Load、Analyze、Mapping、Unload 操作状态
│   ├── runs/<run_id>/         Run、RunItem、日志与产物
│   └── tmp/<ref>.io-schema.json  IO Schema
├── test/                      引擎回归测试（Node 自带 test runner，零依赖）
├── .agents/skills/            项目级 Skill：SkillApp 自己的操作手册
│   ├── skillapp/              操作入口：装载 / 映射 / 执行
│   └── analyze-skill-io/      读 Skill → IO 契约 + 风险清单
├── docs/                      设计文档
├── README.md
└── .gitignore
```

**两个 `skills` 不是一回事**，别混：

| 路径 | 是什么 | 进 Git |
|---|---|---|
| `.agents/skills/` | SkillApp 自己的操作手册，给 Agent 用（项目级 Skill） | ✅ |
| `.data/skills/` | 被装载进来、准备执行的 Skill | ❌ 内容 |

`.data/` 的四个子目录各有一个 `README.md` 说明用途，因此克隆后仍能看见结构、知道缺什么。

**跑测试**：在仓库根跑 `node --test` —— 用 Node 自带的 test runner，仓库没有 `package.json`，也不需要装依赖。测试通过临时目录和假 `lark` 响应覆盖真实 CLI 与执行主逻辑，写操作全落在系统临时目录。

## 两个阶段

```
① 初始化   装载（复制 + 分析）→ 映射      把一个 Skill 变成可运行的 Template
   load-skill.js + analyze-skill-io  →  评审  →  map-table.js

② 执行     跑批量、回写结果
   run-template.js
```

**执行为什么不做成 Skill：** 每跑一行就把 LLM 放进回路 = 慢、贵、不可重放，且等于让非确定性组件去写生产数据。
**分析为什么和映射分开：** `analyze` 要读任意实现、做类型取舍，只能是 Skill；`map` 是机械的，做成脚本才确定、可重跑、可 diff。中间那次人工评审也有了落脚点，并带可执行的默认建议。

**装载为什么包含分析：** 从用户视角，交出去一个 Skill 路径，意图就是「把它纳进来」——而单纯复制不产生任何可判断的东西，分析才是他要评审的成果。而且上游一改就必须重新装载，重新分析本来就应该跟着发生。

**装载为什么不和映射合并：** 触发频率差一个数量级（装载随上游改动、映射极少），影响范围也不同（装载只动本机文件，映射要改用户表格结构）。

## 列命名与删列

**命名规范**（前缀只给人看；机器绑定一律用 `field_id`，所以改名不会破坏映射）

| 区 | 格式 | 例 |
|---|---|---|
| 主字段 | 行名，无前缀 | `任务名称` |
| 输入 | `in: <标签>`，必填项行首加全角 `＊` | `＊in: 网格数` |
| 输出 | `out: <标签>` | `out: 切片数` |

**删列是预期用法。** 映射条目允许比表「宽」，执行前会与当前表格对账：

| 情形 | 行为 |
|---|---|
| 删掉非必填输入列 | 从映射中剔除；对应参数**整对省略**（如 `-f` 一起消失），Skill 用它自己的默认行为 |
| 删掉输出列 | 不再回写该列 |
| 删掉必填输入列 | **拒绝运行**，报明确的错 |
| 列还在但类型变了 | **拒绝运行** |

副作用：删掉某个输入列会改变输入指纹，相关行会在下次 `--pending` 时**重跑一次**。

## 三条不变量

1. **Template 里不出现绝对路径。** Skill 只写相对 `.data/` 的 `skills/<ref>` 路径 + 内容 `hash`。
2. **绑定一律用 `field_id`，不用字段名。** 名字随时会被改。
3. **加载时核对，不靠自觉。** 启动时校验 Skill 内容指纹、每个 `field_id` 的存在与类型。

## 已知边界

刻意留着的缺口，不是遗漏：

- **串行执行，没有并发。** 逐行处理，也没有租约机制。多机或并行要先解决"谁拥有这一行"。
- **失败行会被 `--pending` 反复捞出**（它就是「最近一次没成功」）。要让某行退出待运行，只能修输入或用 `--record-id`。
- **`.data/runs/` 只增不减**，产物、日志都在里面，目前没有清理策略。
- **`--pending` 每次读取全部历史文件。** 内存只保留每行最近状态；行数上万后仍需建索引。
- **一个 Skill 只能映射到一张表。** `.data/templates/<ref>.json` 只按 Skill 名命名，所以把同一个 Skill 映射到第二张表会**直接覆盖**第一份，连 `template_id` 都会沿用它。要支持多表，需把表格标识写进文件名（`<ref>.<table_id>.json`）——现在不做。
- **Template 不可恢复。** 它不进 Git，克隆后无法还原；需要多人共享同一份 Template 时应把它放回 Git。
- **只支持 JSON stdout 的 Skill。** 执行器直接 `JSON.parse` 标准输出；输出散文或非 JSON 的 Skill 需要先补一层解析。
- **Skill 必须有可执行入口。** 执行器需要 spawn 一个命令行进程；纯方法论型 Skill（只有 `SKILL.md`，没有脚本）无法执行——那需要另一套执行模型。

## 什么时候该再分层

代码按**层次**分：`src/cli/` 只放命令薄壳，`src/core/` 放内部模块，`src/server/` 和 `src/web/` 放 Web 控制台。运行时数据统一放在 `.data/`。

出现以下任一情况再动结构：

- 需要对外提供调用（HTTP / SDK）→ 把逻辑从 CLI 抽出来，CLI 变成薄壳
- `run-template.js` 里出现第二个 Skill 的特例分支 → 该往 Template 加字段，而不是加 `if`

## Web UI

初始化与执行控制台已经实现：浏览器可以输入 Skill 根目录完成装载（默认完整导入）并进入详情页，点击 Analyze 生成 IO Schema，输入 Feishu Base URL 后点击 Mapping 生成 Template；也可以启动增量/全量 Run、实时查看每行阶段与 stdout/stderr、取消运行、重试失败行，并查看 RunItem、日志和产物。

```bash
# 首次运行可复制一份环境配置
cp .env.example .env

node src/server/index.js --port 4173 --token '<token>'
# 打开 http://127.0.0.1:4173
```

本机访问时 token 可省略；监听非本机地址时必须设置 token，或显式使用 `--insecure`。

服务启动时会自动读取应用根目录的 `.env`。Web 分析默认调用本机已登录的 `codex exec`；常见配置包括：

```bash
SKILLAPP_ANALYZE_COMMAND=codex
SKILLAPP_ANALYZE_MODEL=<optional-model>
SKILLAPP_ANALYZE_REASONING_EFFORT=low
SKILLAPP_ANALYZE_TIMEOUT_MS=900000
```

完整方案和后续 milestone 见 [`docs/web-ui.md`](docs/web-ui.md)。
