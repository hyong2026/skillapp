# SkillApp

**一个容器**：装载 skill，把 skill 的 IO 映射到飞书 Base，并具备执行能力。

三件事，不多不少：

| | |
|---|---|
| **装载** | 导入 skill 并固定版本（`bin/skill-import.js`） |
| **映射** | skill 的输入输出 ←→ Base 的列（`init/`） |
| **执行** | 按 Template 批量跑，结果回写（`bin/run-template.js`） |

## 使用

```bash
# 1. 装载 skill
node bin/skill-import.js /path/to/skill --ref <name>

# 2. 初始化 Template —— 由 agent 按这两份说明执行
#    init/analyze/SKILL.md    读 skill → IO 契约 + 风险清单
#         ↓ 人工确认（必须）
#    init/scaffold/SKILL.md   契约 → Base 列 + templates/<name>.template.json

# 3. 自检：核对 skill 指纹、字段存在性与类型，打印解析出的 argv
node bin/run-template.js templates/<name>.template.json --dry-run

# 4. 执行
node bin/run-template.js templates/<name>.template.json --pending
```

`--pending` 只跑 **在 `runs/` 历史中没有成功记录、或输入已变**的行，因此可安全重复执行。

`-h` 查看各命令的完整选项。

## 边界

> **Base 里只存 IO 数据。** 只有输入列、输出列，外加一个文本主字段作行名。
> 运行状态、Run、RunItem 一律不进 Base——它们记在 `runs/` 目录里。

| 谁管 | 存什么 |
|---|---|
| 飞书 Base | 用户的输入与输出 |
| `templates/` | Template + Mapping（定义） |
| `runs/` | Run + RunItem + 产物（状态） |

## 目录

```
skillapp/
├── bin/                       引擎
│   ├── skill-import.js        装载：导入 skill
│   ├── run-template.js        执行：读行 → 跑 skill → 回写
│   └── skill-hash.js          内容指纹（内部模块）
├── init/                      映射：把一个 skill 变成 Template
│   ├── analyze/SKILL.md       读 skill → IO 契约 + 风险清单
│   └── scaffold/SKILL.md      契约 → Base 列 + Template
├── skills/<ref>/              导入的 skill —— 内容不进 git
├── templates/                 Template —— 内容不进 git
└── runs/<run_id>/             Run 与 RunItem —— 内容不进 git
```

三个内容目录各有一个 `README.md` 说明用途，因此克隆后仍能看见结构、知道缺什么。

## 两个阶段

```
① 初始化   要判断，是 Skill
   analyze → 风险清单 → 人审 → scaffold

② 执行     要确定，是 Runtime
   run
```

**第二步为什么不做成 Skill：** 每跑一行就把 LLM 放进回路 = 慢、贵、不可重放，且等于让非确定性组件去写生产数据。
**第一步为什么拆两段：** 中间那次人工确认必须有个落脚点。推断是建议，不是事实。

## 三条不变量

1. **Template 里不出现绝对路径。** 只写 `ref` + `hash`；上游位置记在 `source_hint`（非运行时字段）。
2. **绑定一律用 `field_id`，不用字段名。** 名字随时会被改。
3. **加载时核对，不靠自觉。** 启动时校验 skill 内容指纹、每个 `field_id` 的存在与类型，不符即拒绝运行。

## 已知边界

刻意留着的缺口，不是遗漏：

- **无并发锁。** 并发度 1，单执行器。多机时需把租约放进真实数据库。
- **失败行会被 `--pending` 反复捞出**（它就是「没有成功记录」）。要让某行退出待运行，只能修输入或用 `--record-id`。
- **`runs/` 只增不减**，产物、日志都在里面，目前没有清理策略。
- **`--pending` 每次扫描全部历史。** 行数上万后需建索引。
- **Template 不可恢复。** 它不进 git，克隆后无法还原；需要多人共享同一份 Template 时应把它放回 git。
- **只支持 JSON stdout 的 skill。** Template 的 `invocation.parse` 目前只有 `json_stdout` 一种取值。
- **skill 必须有可执行入口。** runner 需要 spawn 一个命令行进程；纯方法论型 skill（只有 `SKILL.md`，没有脚本）无法执行——那需要另一套执行模型。

## 什么时候该再分层

现在三个文件平铺在 `bin/`，够了。出现以下任一情况再拆：

- `bin/` 超过 5 个文件 → 分出 `bin/`（入口）+ `src/`（模块）
- 需要对外提供调用（HTTP / SDK）→ 把逻辑从 CLI 抽出来
- `run-template.js` 里出现第二个 skill 的特例分支 → 该往 Template 加字段，而不是加 `if`