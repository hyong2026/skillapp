# SkillApp Web UI

> 状态：初始化、映射与执行控制台已实现；长期运行加固待开发。
> 前提：单实例、单用户或可信内网、单飞书身份；文件系统仍是运行状态的唯一真相。
> 目标：让用户通过浏览器完成 `装载 → 分析确认 → 映射 → 执行 → 查看结果`。

## 1. 定位与边界

Web UI 是 SkillApp 的控制台，不是第二个执行引擎。CLI、HTTP、测试和 Web 共用 `src/core/` 中的业务逻辑。

分析由 `analyze-skill-io` 完成。Web 在点击 Analyze 后调用本地分析器（默认 `codex exec`）生成 IO Schema；默认使用低推理强度，并可用 `SKILLAPP_ANALYZE_MODEL`、`SKILLAPP_ANALYZE_REASONING_EFFORT` 调整速度。

### 成功标准

- 用户不执行 CLI，也能完成一次 Skill 初始化并生成 Template。
- 所有长任务都有持久状态、可订阅进度、可取消。
- Load、Analyze、Mapping 都作为持久化操作在后台执行；页面刷新后恢复 Loading 状态。
- 同一资源不会被不安全的并发操作同时修改。
- 服务和浏览器刷新后，可以恢复历史状态和当前进度。
- CLI 仍然可用，并与 Web 共用核心逻辑。

## 2. 已实现能力

### 查看

- 读取 Skill、Template、Run、RunItem、stdout/stderr 和 artifacts。
- IO Schema、stdout、stderr 和 JSON 使用语法高亮。
- 支持 Basic Auth / Bearer token。
- 防止静态资源路径穿越，并将产物访问限制在对应 Run/record 目录。

### 执行

- `run-template` 由独立 worker 进程执行，不阻塞 HTTP 事件循环。
- Run 启动时立即以 `queued` 状态落盘，再进入 `running`。
- 通过 SSE 推送 Run 快照、RunItem 状态、阶段和 stdout/stderr。
- 支持 `pending`、`all`、`record-id` 和 dry-run API。
- 支持取消运行、失败行重试和 Template 级锁。
- Template 详情页提供 `Run`，默认执行 `pending`；勾选 `All Rows` 后执行全量。

### 初始化

- 输入 Skill 根目录装载，并默认导入全部内容，包括 `node_modules`。
- 装载只复制 Skill 并进入详情页；点击 `Analyze` 后生成 `.data/tmp/<ref>.io-schema.json`。
- 检查 `SKILL.md`、Skill ref 和源目标重叠。
- `io-schema.json` 带版本、Skill hash、完整校验与原子保存。
- 待确认项包含 `recommendation / rationale / default`；未回答时采用建议。
- Schema 可在线编辑；Skill 变化后分析结果标记为 `stale`。
- Mapping 操作内部生成 `plan_hash + diff`，覆盖复用列、新增列、类型冲突、必填风险和列顺序。
- Mapping 在执行前重新校验计划；实时结构变化时拒绝写出。
- Template JSON 可以导出。
- 卸载先返回影响清单和 `plan_hash`，确认后才删除本地文件。

## 3. 当前架构

```text
Browser
  │ HTTP/JSON + SSE
  ▼
API Server
  │
  ▼
Task Runner
  ├── run-worker 子进程  → core/run-template
  └── task-worker 子进程 → core/load-skill
                          → core/map-table
                          → core/unload-skill
  │
  ├── lark-cli（argv 数组，不经过 shell）
  └── .data/ 文件系统
```

### 分层

| 目录 | 职责 |
|---|---|
| `src/cli/` | 参数解析、终端输出和退出码；业务逻辑下沉到 core |
| `src/core/` | CLI、HTTP、worker 和测试共用的业务逻辑 |
| `src/server/` | HTTP 路由、鉴权、任务执行器、worker 和 SSE |
| `src/web/` | 零依赖静态控制台 |
| `.data/` | Skill、Template、Run、Operation、日志和产物的运行时数据 |

### 关键模块

| 模块 | 职责 |
|---|---|
| `src/core/load-skill.js` | 根目录校验、完整复制、版本固定和原子替换 |
| `src/core/analyze-skill.js` | 调用本地分析器，校验结果并持久化 IO Schema |
| `src/core/io-schema.js` | Schema 版本、校验、待确认项和原子保存 |
| `src/core/map-table.js` | Mapping 计划、diff、plan hash、表格结构写出和 Template 生成 |
| `src/core/unload-skill.js` | 卸载影响清单、plan hash 和受控删除 |
| `src/core/run-template.js` | Run 预检、选行、执行、回写、进度与状态 |
| `src/server/task-runner.js` | 启动 worker、资源锁、状态事件、取消和中断恢复 |
| `src/server/run-worker.js` | 在独立进程中执行 Run |
| `src/server/task-worker.js` | 在独立进程中执行装载、Mapping 和卸载任务 |
| `src/server/read-model.js` | 只读扫描 Skill、Template、Run、Operation、日志和产物 |
| `src/server/app.js` | HTTP API、SSE、鉴权、同源写保护和静态资源 |
| `src/web/app.js` | Hash 路由、初始化向导、详情页、任务 SSE 客户端 |

## 4. 页面与交互

### Skills

- 列表展示 `Ref / Status / Loaded / Source`。
- `Load` 打开弹框，只输入 Skill Root 绝对路径；目录名自动作为 Ref，默认完整导入。
- Load 完成后直接进入 Skill 详情页，不自动分析。
- 详情页右上角提供 `Analyze / Re-analyze`；分析作为持久化任务运行，页面刷新后恢复 Loading。
- 详情展示 Skill 状态和 IO Schema。
- Skill 状态为 `Unanalyzed / Analyzing / Ready / Stale / Unverified / Invalid`。
- `IO Schema` 默认展示结构化 Inputs/Outputs；`JSON` 开关查看原始 JSON。
- 详情页右上角 `Mapping` 打开弹框，输入 Feishu Base URL；点击一次即启动持久化 Mapping 任务，页面刷新后仍保持 Loading。
- 详情页右上角 `Unload` 一键卸载 Skill、Template、分析产物和关联 Run；飞书列不会被删除。

### Templates

- 列表展示 `Ref / Template ID / IO / Last Run / Created`。
- 详情 Summary 展示 Template ID、Skill、Skill Hash、Feishu Base URL 和创建时间。
- `Template Definition` 展示完整 Inputs/Outputs Mapping；`JSON` 开关展示完整 Template JSON。
- 页面右上角提供 `Run`；`All Rows` 勾选框决定 `all` 或 `pending`。

### Runs

- 列表展示状态、Template、触发方式、成功/失败数和开始时间。
- Run 详情展示摘要、进度条、RunItem 状态、Stdout、Stderr 和 Live Output。
- RunItem 详情展示状态、阶段、耗时、错误、输入 Hash、Artifacts 和两种日志。
- 运行中的 Run 支持取消；终态 Run 存在失败行时，可以创建只包含失败行的新 Run。

### UI 约定

- 静态 UI 文案统一使用英文。
- 表头、字段标签和面板标题首字母大写。
- 默认路由是 `#skills`，不提供 Home 页面。
- 列表和 Summary 不展示无意义的统计块。
- 日期时间统一为 `YYYY-MM-DD HH:mm:ss`。
- JSON、Markdown、Stdout、Stderr 均使用代码块展示。

## 5. 异步操作与执行模型

### 状态

```text
queued → running → completed
                 ├→ canceled
                 ├→ failed
                 └→ interrupted
```

Run 额外使用 `partial` 表示部分成功；dry-run 使用 `dry-run` 终态，不写入 `.data/runs/`。

### 生命周期

1. API 创建异步操作，立即写入 `queued`。
2. Task Runner 获取资源锁并启动对应 worker。
3. worker 更新为 `running`，执行核心服务。
4. 状态、进度和结果原子更新到 `operation.json` 或 `run.json`。
5. 终态后写入结果并释放锁。

### 资源锁

| 操作 | 资源键 |
|---|---|
| Run | `template:<template_id>` |
| Load / Unload Skill | `skill:<ref>` |
| Apply Mapping | `skill:<ref>` + `table:<base>:<table>` |

同一个资源被占用时，新的写操作返回冲突，不排队等待。

### 预览与计划

map-table 操作使用纯计划逻辑：

```text
当前 Schema + Skill hash + 目标表格结构 + 已有 Template
  → plan
  → plan_hash
```

执行前重新计算计划并校验 `plan_hash`，不一致就拒绝写出。卸载使用相同规则。

### 取消与重试

- 取消请求先进入 `canceling`，随后终止 worker 进程组。
- 取消不能回滚已经提交到飞书的写回。
- Run 只允许对终态失败行重试。
- 重试会创建新的 Run，不修改原 Run 历史。

## 6. HTTP API

### 鉴权与响应

- 鉴权支持 Basic Auth 和 Bearer token。
- 写接口校验同源请求，拒绝跨站写入。
- 成功响应统一为：

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

错误使用稳定的 `code + message + action`：

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "MAPPING_PLAN_STALE",
    "message": "Mapping plan is missing or stale",
    "action": "Preview the mapping again, review the latest changes, then apply"
  }
}
```

### 读取

```text
GET    /api/status
GET    /api/skills
GET    /api/skills/:ref
GET    /api/skills/:ref/analysis
GET    /api/templates
GET    /api/templates/:id
GET    /api/runs
GET    /api/runs/:id
GET    /api/runs/:id/events
GET    /api/runs/:id/items/:recordId
GET    /api/runs/:id/artifacts/:recordId/:file
GET    /api/skills/:ref/events
GET    /api/skills/:ref/operations/:kind
```

### 写入

```text
POST   /api/skills/load
POST   /api/skills/:ref/analyze
PUT    /api/skills/:ref/io-schema
DELETE /api/skills/:ref

POST   /api/mappings

POST   /api/runs/preview
POST   /api/runs
POST   /api/runs/:id/cancel
POST   /api/runs/:id/retry
```

异步接口返回 `202 + operation`。`/events` 是 SSE；操作事件包括：

```text
snapshot
progress
error
done
```

Run 事件包括：

```text
snapshot
run-created
item-started
item-stage
item-log
item-finished
run-finished
done
error
```

## 7. 状态与持久化

```text
.data/
├── skills/<ref>/
│   ├── SKILL.md
│   └── source.json
├── templates/<ref>.json
├── operations/<operation_id>/
│   └── operation.json
├── runs/<run_id>/
│   ├── run.json
│   └── <record_id>/
│       ├── downloads/
│       ├── artifacts/
│       └── logs/
│           ├── stdout.json
│           └── stderr.json
└── tmp/
    └── <ref>.io-schema.json
```

### 约定

- 文件系统是唯一真相，当前不引入数据库。
- JSON 状态文件使用临时文件 + rename 原子更新。
- `run.json` 在 Run 启动时创建，并在状态或 RunItem 变化时更新。
- `operation.json` 记录 Load、Analyze、Mapping、Unload 的状态、输入、结果和错误。
- stdout/stderr 以 JSON 文件保存，内容可以是对象、数组、标量或原始文本。
- Artifacts 只能通过 Run、record 和相对路径定位。
- 服务启动时扫描活动 Run/Operation，并标记为 `interrupted`。

## 8. 后续加固

以下是长期运行前需要补齐的能力，不改变当前初始化与执行流程：

- **并发与队列**：为不同 Template 的并发增加全局上限，增加排队状态和最大队列长度。
- **租约与孤儿清理**：worker 定期写 heartbeat；超时任务标记为 `interrupted`，并清理孤儿进程。
- **崩溃恢复**：覆盖 HTTP 进程退出、worker 被 `SIGKILL`、写回中断和状态文件损坏。
- **幂等边界**：明确写回是至少一次语义；取消不能回滚已提交的写回。
- **安全加固**：覆盖符号链接、路径穿越、命令参数、SSRF、产物下载和 CSRF。
- **日志脱敏**：日志和 SSE 对 token、cookie、授权信息做脱敏。
- **输出保护**：限制 stdout/stderr 单行、单流和单 Run 大小，增加日志轮转和磁盘水位检查。
- **保留与清理**：提供 Run/Operation 保留策略，清理前预览目录和容量。
- **可观测性**：增加 `/api/health`、队列深度、活跃 worker、失败率和磁盘占用指标。
- **扩展准备**：Run 列表先分页；出现可测瓶颈后再增加只读索引。

### 加固验收

- 全局并发上限不会被突破。
- worker 被强制终止后，服务能标记任务中断，且不留下孤儿进程。
- 路径穿越、符号链接和超限输出会被拒绝或截断。
- 清理操作先预览后执行，删除范围与预览一致。
- Run 列表分页后，启动和页面加载不会随历史 Run 数量线性恶化。

## 9. 暂不纳入

- 多用户、RBAC、按用户隔离的飞书 OAuth。
- 定时执行、Webhook 触发、失败通知。
- 多机/多实例、分布式队列和跨实例租约。
- 对象存储和远程产物访问。
- 在 Web 中任意编辑飞书表结构；只允许受控的 Mapping Apply。
- 在 Web 服务中运行完整 LLM 分析流程。

## 10. 环境配置

服务启动时自动加载应用根目录的 `.env`，且不会覆盖 shell 中已存在的变量。

```bash
cp .env.example .env
```

示例变量：

```dotenv
SKILLAPP_WEB_TOKEN=
SKILLAPP_ANALYZE_COMMAND=codex
SKILLAPP_ANALYZE_MODEL=deepseek/deepseek-v4.1-flash
SKILLAPP_ANALYZE_REASONING_EFFORT=low
SKILLAPP_ANALYZE_TIMEOUT_MS=900000
```

`.env` 不进 Git，`.env.example` 进 Git。

## 11. 当前产品约束

- 部署形态：单实例、可信环境，默认只监听 `127.0.0.1`。
- Skill 来源：本地 Skill 根目录的绝对路径。
- 分析来源：由 `analyze-skill-io` 产出；Web 默认通过 `codex exec` 调用，可用 `SKILLAPP_ANALYZE_COMMAND` 替换分析器。
- 飞书身份：全站共用一个 `lark-cli` 身份。
- Template：保留在本机文件系统，并提供 JSON 导出。
