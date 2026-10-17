# 架构与工程约定

## 分层

```text
Browser ──HTTP/JSON + SSE──▶ API Server ──▶ Task Runner
                                             ├── run-worker 子进程  → core/run-template
                                             ├── task-worker 子进程 → core/load-skill / bind-table / unload-skill / delete-run / template
                                             ├── lark-cli（argv 数组，不经过 shell）
                                             └── .data/ 文件系统
```

| 目录 | 职责 |
|---|---|
| `src/cli/` | 参数解析、终端输出和退出码；业务逻辑下沉到 core |
| `src/core/` | CLI、HTTP、worker 和测试共用的业务逻辑 |
| `src/server/` | HTTP 路由、鉴权、任务执行器、worker、SSE |
| `src/web/` | 零依赖静态控制台 |
| `.data/` | Skill、Template、Mapping、Run、Operation、日志和产物的运行时数据 |

## 关键模块

| 模块 | 职责 |
|---|---|
| `src/core/paths.js` | 所有内容目录的唯一路径来源 |
| `src/core/load-skill.js` | 根目录校验、完整复制、版本固定和原子替换 |
| `src/core/skill-hash.js` | Skill 内容指纹 |
| `src/core/skill-meta.js` | 读 `SKILL.md` frontmatter（目前取 `description`） |
| `src/core/ref.js` | Skill ref 白名单与校验 |
| `src/core/mapping.js` | Mapping 校验、`mapped` 规则与原子保存 |
| `src/core/analyze-skill.js` | 调用本地分析器，校验结果并持久化 Mapping |
| `src/core/bind-table.js` | Mapping 计划、diff、plan hash、建列与 Template 生成 |
| `src/core/template.js` | Template 身份（Skill + 目标表）与文件名、按目标定位、归档状态 |
| `src/core/unload-skill.js` | 卸载影响清单、plan hash 和受控删除 |
| `src/core/delete-run.js` | 逻辑删除单次 Run（写 `deleted_at`，文件保留） |
| `src/core/run-template.js` | Run 预检、选行、执行、回写、进度与状态 |
| `src/core/lark.js` | `lark-cli` 封装：同步 `lark`（一次性调用）与异步 `larkAsync`（按行调用，不阻塞事件循环）；可注入替身，测试用 |
| `src/core/settings.js` | 设置白名单，读写仓库根 `.env` |
| `src/server/app.js` | HTTP API、SSE、鉴权、同源写保护和静态资源 |
| `src/server/task-runner.js` | 启动 worker、资源锁、状态事件、全局操作订阅、取消和中断恢复 |
| `src/server/operation-summary.js` | 一条操作的摘要（Operations 列表与全局 SSE 共用） |
| `src/server/read-model.js` | 只读扫描 Skill、Template、Run、Operation、日志和产物 |
| `src/server/run-worker.js` | 在独立进程中执行 Run |
| `src/server/task-worker.js` | 在独立进程中执行装载、Mapping、卸载、归档与删除 Run |
| `src/web/` | 入口 `app.js` + `index.html`/`styles.css`；共用件在 `lib/`，页面在 `views/` |

## 落盘布局与约定

```text
.data/
├── skills/<Skill Name>/{SKILL.md,source.json,...}
├── mappings/<Skill Name>.mapping.json
├── templates/<Skill Name>-<目标指纹>.template.json
├── operations/<operation_id>/operation.json
└── runs/<run_id>/{run.json,<record_id>/{downloads,artifacts,logs}}
```

- **文件系统是唯一真相**，当前不引入数据库。
- JSON 状态文件一律**临时文件 + rename** 原子更新。
- `run.json` 在 Run 启动时创建，状态或 Run Item 变化时更新。
- `operation.json` 记录异步操作的状态、输入、结果和错误；Run 只在这里留一份索引（mirror），明细仍在 `.data/runs/`。
- stdout/stderr 以 `.log` 文本原样保存。
- 服务启动时扫描活动 Run/Operation，标成 `interrupted`（不自动续跑）。
- `.data/` 除各自的 `README.md` 外不进 Git。

## 操作生命周期与锁

```text
queued → running → completed | failed | canceled | interrupted
```

1. API 创建异步操作，立即以 `queued` 落盘（`operation.json` 或 `run.json`）。
2. Task Runner 抢占资源锁，启动对应 worker 子进程。
3. worker 置 `running`，执行 core 里的核心逻辑；进度与结果原子写回。
4. 终态写入结果、释放锁，并通过 SSE 通知订阅者。

| 操作 | 资源键 |
|---|---|
| Run | `template:<template_id>` |
| Load / Unload / Analyze | `skill:<ref>` |
| Bind（bind-table） | `skill:<ref>` + `table:<base>:<table>` |
| 归档 / 解冻 | `template:<template_id>` |

同一个资源被占用时，新的写操作直接返回冲突，不排队。

**计划与校验**：bind-table 与 unload 都先生成 `plan`（含 `plan_hash`），写入前重新计算并比对；不一致就拒绝，避免拿过期计划去改真实数据。

**取消**：先置 `canceling`，再终止 worker 进程组；已提交到飞书的写回无法回滚。
**重试**：只允许终态且有失败行的 Run，等价于再跑一次增量，产生新 Run，不改历史。

## 代码形态

- `src/` 与 `test/` 都是 ES 模块（各有一份 `{"type": "module"}` 的 `package.json`），运行时**零依赖**，需要 Node ≥ 22。
- 根 `package.json` 故意不声明 `type`：`.data/` 因此保持 Node 默认行为——装载进来的 Skill 可能是 Node、也可能是 Python，语言由 Skill 自己声明。
- 测试用 Node 自带 runner（`node --test`）：真跑 CLI 与执行主逻辑，只把 `src/core/lark` 换成内存替身，写操作全在系统临时目录。

## 什么时候该再分层

代码按**层次**分：`src/cli/` 只放命令薄壳，`src/core/` 放内部模块，`src/server/` 与 `src/web/` 放控制台。运行时数据统一在 `.data/`。

出现以下任一情况再动结构：

- 需要对外提供调用（HTTP / SDK）→ 把逻辑从 CLI 抽出来，CLI 变成薄壳。
- `run-template.js` 里出现第二个 Skill 的特例分支 → 该往 Template 加字段，而不是加 `if`。

## 后续加固

长期运行前需要补齐的能力（不改变当前的初始化与执行流程）：

- **并发与队列**：不同 Template 的并发上限、排队状态与最大队列长度。
- **租约与孤儿清理**：worker 定期 heartbeat；超时任务标记 `interrupted` 并清理孤儿进程。
- **崩溃恢复**：覆盖 HTTP 进程退出、worker 被 `SIGKILL`、写回中断和状态文件损坏。
- **幂等边界**：明确写回是至少一次语义；取消不能回滚已提交的写回。
- **安全加固**：符号链接、路径穿越、命令参数、SSRF、产物下载和 CSRF。
- **日志脱敏**：日志与 SSE 对 token、cookie、授权信息脱敏。
- **输出保护**：限制 stdout/stderr 单行/单流/单 Run 大小，日志轮转与磁盘水位检查。
- **保留与清理**：Run/Operation 保留策略，清理前预览目录与容量。
- **可观测性**：`/api/health`、队列深度、活跃 worker、失败率、磁盘占用。
- **扩展准备**：列表已做前端分页（每页 10 条）；服务端分页与只读索引等出现可测瓶颈再做。

## 暂不纳入

- 多用户、RBAC、按用户隔离的飞书 OAuth。
- 定时执行、Webhook 触发、失败通知。
- 多机/多实例、分布式队列和跨实例租约。
- 对象存储和远程产物访问。
- 在 Web 中任意编辑飞书表结构（只允许受控的 Mapping Apply）。
- 在 Web 服务中运行完整 LLM 分析流程。

## 产品约束

- 部署形态：单实例、可信环境，默认只监听 `127.0.0.1`。
- Skill 来源：本地 Skill 根目录的绝对路径。
- 分析来源：由 `analyze-skill` 产出；默认通过 `codex exec` 调用，可用 `SKILLAPP_ANALYZE_COMMAND` 替换。为了少花回合，prompt 里**内联**了规则、文件清单（排除 `node_modules`）与 SKILL.md，结果用 `-o`（`--output-last-message`）从"最后一条消息"收、由 SkillApp 自己落盘；同时用 `-c project_doc_max_bytes=0` 关掉仓库 AGENTS.md 注入。模型与推理强度决定每回合延迟，是 analyze 耗时的主要变量。
- 飞书身份：全站共用一个 `lark-cli` 身份。
- Template 保留在本机文件系统，界面可查看完整 JSON。

## 已知边界

刻意留着的缺口，不是遗漏：

- **并发只在本机、只在一个 Run 内。** 同一批同时跑 `SKILLAPP_RUN_CONCURRENCY` 行（默认 4、上限 8），没有租约机制：多机或跨实例并行要先解决"谁拥有这一行"。
- **失败行会被 `--incremental` 反复捞出**（它就是「最近一次没成功」）。要让某行退出待运行，只能修输入。
- **`.data/runs/` 只增不减**，产物、日志都在里面，目前没有清理策略。
- **`--incremental` 每次读取全部历史文件。** 内存只保留每行最近状态；行数上万后仍需索引。
- **一张表（含视图）一份 Template。** 同一个 Skill 映射到不同 base / table / view 会各生成一份；三元组完全一致才原地更新——视图算数。
- **Template 与数据不进 Git**，克隆后无法还原；需要多人共享时得把 Template 放回 Git。
- **只支持 JSON stdout 的 Skill**（没有输出列时例外；此时不解析 stdout）。
- **Skill 必须有可执行入口**：纯方法论型 Skill（只有 `SKILL.md`）无法执行，那需要另一套执行模型。
