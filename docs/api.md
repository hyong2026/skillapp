# HTTP API

图形控制台用的接口。同源、单实例、可信环境；鉴权可用 Basic Auth 或 Bearer token（`SKILLAPP_WEB_TOKEN`）。

## 鉴权与响应

- 未登录的非本机请求返回 `401` 并带 `WWW-Authenticate`。
- 写接口校验同源（`Origin` / `Sec-Fetch-Site`），跨站写入被拒绝。
- 成功统一：

```json
{ "ok": true, "data": {}, "error": null }
```

- 失败统一带稳定的 `code + message + action`（`action` 是给人看的一步处置建议）：

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

- 异步接口返回 `202 + operation`（含 `operation_id`、`type`、`status`、`input`）。
- 所有 `:ref` / `:id` 都做白名单校验（`[A-Za-z0-9._-]+`，不含 `.` / `..`）。

## 端点

### 读取

```text
GET    /api/status
GET    /api/skills[?page=1]                     # 列表都是服务端分页，见下
GET    /api/skills/:ref
GET    /api/templates[?page=1][&include_archived=1]   # include_archived=1 连归档一起返回
GET    /api/templates/:id                       # id 可用 template_id 或文件名（Template Name）
GET    /api/runs[?page=1][&trigger=incremental][&include_deleted=1]  # trigger 服务端过滤；逻辑删除的默认不列
GET    /api/runs/:id
GET    /api/runs/:id/events                     # SSE
GET    /api/runs/:id/items/:recordId
GET    /api/runs/:id/artifacts/:recordId/:file
GET    /api/operations[?page=1][&type=bind-table]     # type 在服务端过滤
GET    /api/operations/events                   # SSE：全局操作流
GET    /api/operations/:operation_id
GET    /api/operations/:operation_id/events     # SSE：单条操作的进度流
GET    /api/settings
```

列表接口（`/api/skills`、`/api/templates`、`/api/runs`、`/api/operations`）都是服务端分页，
每次只返回当前这一页；只有 `?page=` 一个参数，页长由服务端的 `SKILLAPP_PAGE_SIZE` 决定
（默认 10，上限 200）。页号越界会夹到最后一页，不会给空页：

```json
{
  "ok": true,
  "data": {
    "items": [],
    "total": 85,
    "page": 1,
    "page_size": 10
  },
  "error": null
}
```

`/api/status` 只给计数（运行信息在 `/api/settings`）：

```json
{
  "readonly": false,
  "generated_at": "2026-10-14T09:00:00.000Z",
  "counts": { "skills": 3, "valid_skills": 3, "templates": 4, "runs": 12, "failed_runs": 6 }
}
```

`/api/settings` 返回 `env_file`（`.env` 路径）、`runtime`（Node 版本、内容根、仓库根、是否需要令牌）、`editable`（白名单六项：分析器四项 + `SKILLAPP_RUN_CONCURRENCY` + `SKILLAPP_PAGE_SIZE`，带当前值与来源）和 `readonly`（`SKILLAPP_WEB_TOKEN` / `SKILLAPP_DATA_DIR` / `SKILLAPP_ROOT` / `SKILLAPP_LARK_MODULE`；secret 只返回是否已设置）。

### 写入

```text
POST   /api/skills                      { source_path }
POST   /api/skills/:ref/analyze         {}
PUT    /api/skills/:ref/schema          { mapping }
POST   /api/skills/:ref/bind            { url }  或  { base, table, view }
DELETE /api/skills/:ref[?with_runs=1]   {}         # 默认只删副本 + IO Schema + 它的 Template

POST   /api/runs                        { template_id, trigger }
POST   /api/runs/:id/cancel             {}
POST   /api/runs/:id/retry              {}
DELETE /api/runs/:id                    {}         # 逻辑删除这次 Run（写 deleted_at，文件保留）；正在跑的要先 cancel

POST   /api/templates/:id/preview       { trigger }
POST   /api/templates/:id/archive       {}
POST   /api/templates/:id/unarchive     {}

POST   /api/operations/:operation_id/cancel   {}

PUT    /api/settings                    { values: { KEY: "value" } }
```

## 主要端点说明

### `POST /api/skills`

`source_path` 是本地 Skill 根目录绝对路径；目录名即 `ref`，必须包含 `SKILL.md`。
返回 `202 + operation`，完成后 `result` 含 `ref` / `hash` / `files`。

### `POST /api/skills/:ref/analyze`

调用本地分析器（默认 `codex exec`，可用 `SKILLAPP_ANALYZE_COMMAND` 替换），写 `.data/mappings/<Skill Name>.mapping.json`。
重新分析会**保留用户勾掉的 `mapped: false`**（按 key 合并）。分析结果带 Skill hash，Skill 变了会标记 `stale`。

### `PUT /api/skills/:ref/schema`

Body 是整份 Mapping（结构见 [run.md](run.md#mapping-的结构)）。服务端会校验并原子保存，返回 `{ mapping, state }`。
面板上的每次改动（改名 / 勾选映射 / 排序）都会调用它——只落盘，不改表格。

### `POST /api/skills/:ref/bind`

把这份 IO Schema 绑到某张表：`{ url }`（或 `{ base, table, view }`）。
异步执行，`result` 含 `plan`（`plan_hash`、`create` / `reuse` / 类型冲突 / 必需列风险 / 列顺序）、写出的 `template` 与 `order`。
计划在写入前重新校验：表格结构变了会以 `MAPPING_PLAN_STALE` / `MAPPING_CONFLICT` 拒绝。

### `POST /api/templates/:id/preview`

dry-run：只核对不执行。返回

```json
{
  "template_id": "…",
  "trigger": "incremental",
  "dry_run": true,
  "total": 5,
  "selected": 5,
  "dropped": [],
  "target": { "base_token": "…", "table_id": "…", "view_id": "…" }
}
```

需要飞书授权时返回 `424 LARK_AUTH_REQUIRED`，`action` 给出 `lark-cli auth login` 这类处置。图形控制台的 **Run** 在提交前会先调它一次（弹框里显示会影响多少行，`All Rows` 切换时重调）。

### `POST /api/runs`

启动一次 Run（异步）。`trigger` 取 `incremental`（默认）或 `all`。启动后立刻进入 `queued`，可在 `/api/runs/:id/events` 上跟进度。

- `POST /api/runs/:id/cancel`：先置 `canceling` 再终止 worker 进程组；已提交的写回无法回滚。
- `POST /api/runs/:id/retry`：只允许终态且有失败行的 Run，等价于**再跑一次增量**（失败行本来就会被增量捞出），产生新 Run，不改历史。

### `POST /api/templates/:id/archive` / `unarchive`

归档 = **冻结**：文件保留、从 Templates 列表消失、不能再跑；解冻即恢复。两者都是异步操作，可在 Operations 里查到。

### `PUT /api/settings`

只接受白名单键（`SKILLAPP_ANALYZE_COMMAND` / `_MODEL` / `_REASONING_EFFORT` / `_TIMEOUT_MS` / `SKILLAPP_RUN_CONCURRENCY`），写入仓库根 `.env`（保留注释与行序）并立即生效；其余键只读返回。

## SSE

三条流，帧格式都是 `event: <type>` + `data: <JSON>`，并带 15 秒注释心跳；服务端断开即清理订阅。

| 路径 | 先发 | 之后 |
|---|---|---|
| `/api/operations/:operation_id/events` | 该操作的快照 | `progress`、`error`、`done` |
| `/api/runs/:id/events` | Run 快照 | `run-created`、`item-started`、`item-stage`、`item-log`、`item-finished`、`run-finished`、`error`、`done` |
| `/api/operations/events` | 全量操作快照 `{ operations: [...] }` | 每次变化推 `operation`（单条摘要） |

`/api/operations/events` 是消息区（Messages）的数据源：连上先给全量快照，之后逐条推摘要，**不需要轮询**（Run 的逐行明细仍然只走按 Run 的那条流）。

操作摘要的形状（`GET /api/operations` 与全局流共用）：

```json
{
  "operation_id": "20261014-181500-ab12",
  "type": "bind-table",
  "status": "running",
  "created_at": "…", "started_at": "…", "finished_at": null,
  "duration_ms": null,
  "progress": { "stage": "…" },
  "subject": { "type": "template", "id": "…", "label": "image-split-0e12ab34" },
  "counts": null,
  "trigger": null,
  "error": null
}
```

## 常见错误

| code | 场景 |
|---|---|
| `INVALID_PATH` / `INVALID_SKILL_REF` | 路径或 ref 不合法 |
| `SKILL_NOT_FOUND` / `TEMPLATE_NOT_FOUND` / `RUN_NOT_FOUND` / `OPERATION_NOT_FOUND` | 对象不存在 |
| `SKILL_NOT_LOADED` | 没装载就想映射 |
| `ANALYSIS_STALE` | Mapping 是用旧版本 Skill 分析出来的，需重新分析 |
| `VIEW_REQUIRED` | 链接缺 `view` 参数 |
| `MAPPING_PLAN_STALE` / `MAPPING_CONFLICT` | 表格结构变了 / 列类型冲突，需重新预览 |
| `TEMPLATE_LOCKED` / `RESOURCE_LOCKED` | 同一资源已有进行中的操作 |
| `LARK_AUTH_REQUIRED` | 飞书未授权，`action` 给出登录命令 |
| `ANALYZER_FAILED` / `ANALYZER_INVALID_RESULT` | 分析器失败或没产出 Mapping |
| `CROSS_ORIGIN_BLOCKED` | 跨站写请求被拒 |

## 静态资源

`/` 与 `/styles.css`、`/app.js`、`/theme-boot.js`、`/lib/*`、`/views/*`、`/logo*.svg` 等由同一个服务提供，路径穿越会被拒绝；产物只能通过 `/api/runs/:id/artifacts/:recordId/<相对路径>` 读取，且被限制在该 Run/record 目录内。
