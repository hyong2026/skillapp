# SkillApp Web UI

> 状态：方案草案  
> 目标：让用户通过浏览器完成装载、分析结果确认、映射、执行和查看结果。  
> 前提：单实例、单用户或可信内网、单飞书身份；文件系统仍是运行状态的唯一真相。

## 1. 定位

Web UI 是 SkillApp 的操作台，不是第二个执行引擎。现有三段流程保持不变：

```text
装载 → 分析报告评审 → 映射 → 执行 → 查看结果
```

Web UI 负责把 CLI 的输入、状态和产物可视化，并提供异步任务控制。分析仍由 `analyze-skill-io` 这类 Agent 流程完成；本方案不要求 Web 服务自己具备 LLM 分析能力。

### 基础能力的成功标准

- 用户能在浏览器里完成一次完整的 `装载 → 映射 → 执行`。
- 所有长任务都是异步任务，有状态、有进度、有日志、可取消。
- 破坏性操作先预览、再确认，不直接改用户表格。
- 服务重启后，历史不丢，未完成任务能被识别为中断。
- CLI 仍然可用，并且和 Web 共用同一套核心逻辑。

## 2. 当前实现与 Web UI 的差距

| 现状 | Web UI 需要 |
|---|---|
| `src/cli/` 里的同步 CLI | 从 CLI 抽出 core service，CLI 只做薄壳 |
| `src/core/lark.js` 使用 `spawnSync` | 长任务不能阻塞 HTTP 事件循环 |
| `run.json` 完成后才写入 | Run 启动时就落盘，并持续更新状态和进度 |
| 没有队列、锁、取消 | 单 worker 队列、Template 级锁、取消和中断恢复 |
| `analyze-skill-io` 是 Agent Skill | Web 只展示/编辑结果，不在服务端重做分析 |
| `load-skill.js` 接受本地路径 | Web 需要上传、允许目录或受控路径三种来源 |
| `map-table.js` 直接改表 | 先 dry-run 出差异，再显式确认应用 |
| `.data/runs/` 只增不减 | 先提供浏览和下载，清理策略暂不纳入 |

## 3. 目标架构

```text
Browser
  │  HTTP/JSON + SSE
  ▼
API Server
  │
  ▼
Job Runner（单 worker）
  │
  ▼
Core Services
  ├── loadSkill
  ├── mapTable
  ├── runTemplate
  └── unloadSkill
  │
  ├── lark-cli（argv 数组，不经 shell）
  └── 文件系统
      ├── .data/skills/
      ├── .data/templates/
      ├── .data/runs/
      └── .data/tmp/
```

### 分层原则

- `src/core/`：可被 CLI、HTTP、测试共同调用的业务逻辑与统一路径配置。
- `src/cli/`：只保留参数解析、输出和错误码。
- `src/server/`：HTTP 路由、鉴权、任务调度、SSE。
- `src/web/`：静态页面和前端资源。
- `.data/`：仍然保存 Skill、Template、Run 和中间产物；本方案先不引入数据库。

## 4. 基础功能

### 4.1 登录与首页

- 访问鉴权：本地部署默认只监听 `127.0.0.1`；对外部署必须配置 token 或反向代理鉴权。
- 首页展示：已装载 Skill 数、Template 数、最近 Run、失败 Run 数。
- 飞书状态：显示 `lark-cli` 是否可用、当前使用的身份来源。
- 全局错误提示：错误必须包含“发生了什么”和“下一步做什么”。

### 4.2 初始化向导：Skill → Template

按现有三步流程设计，但每一步都可预览和回退。

1. **导入 Skill**
   - 从允许目录选择路径，或上传 zip。
   - 校验 `SKILL.md`、`ref` 合法性、源/目标不重叠。
   - 展示装载前后的 hash 变化。

2. **查看分析报告**
   - 展示 `.data/tmp/<ref>.io-report.md` 和 `io-schema.json`。
   - “待确认”项必须显示：
     - **建议**
     - **依据**
     - **默认**
   - 提供“采纳全部建议”，也允许逐项修改。
   - 不自动从分析跳到映射；用户点击“继续映射”后才进入下一步。

3. **映射预览**
   - 输入飞书表格链接，解析 `base_token / table_id / view_id`。
   - dry-run 展示：
     - 将新建的列
     - 将复用的列
     - 主字段是否改名
     - 列顺序变化
     - 类型冲突和必填列风险
   - 用户确认后才真正修改表格。

4. **应用并生成 Template**
   - 调用映射核心逻辑。
   - 展示自检结果。
   - 展示 `template_id`、Skill hash、目标表格和字段绑定摘要。

### 4.3 Template 管理

- Template 列表：名称、Skill、目标表格、创建时间、最近一次 Run。
- Template 详情：
  - Skill 路径和 hash
  - 目标 Base / Table / View
  - 输入、输出和 `field_id` 绑定
  - 当前 work hash
  - 字段缺失、类型不符等预检结果
- 支持下载 Template JSON，便于手工共享或放入 Git。
- Skill 重新装载后，如果 hash 变化，显示“需要重新映射”。

### 4.4 执行控制台

- 选择 Template。
- 触发方式：
  - `pending`：只跑未更新或失败的行
  - `all`：全表重跑，需要二次确认
  - `record-id`：指定行运行
- 运行前展示：
  - 总行数
  - pending 行数
  - 预计目标表格
  - 是否 dry-run
- 运行中展示：
  - Run 状态：queued / running / completed / partial / failed / canceled
  - 总进度：总数、完成数、成功数、失败数
  - 每行 stage：validate / download / exec / upload / writeback
  - 实时 stdout / stderr
- 支持取消；取消后进程树必须被终止，Run 标记为 canceled。
- 同一个 Template 同一时间只允许一个 Run，避免重复写同一张表。

### 4.5 Run 历史与结果

- Run 列表：按 Template、状态、时间筛选。
- Run 详情：摘要、耗时、成功数、失败数。
- RunItem 详情：
  - `record_id`
  - 输入摘要
  - 输出值
  - 错误和失败 stage
  - 单行耗时
- 日志查看器：
  - `stdout.json`
  - `stderr.json`
- 产物：
  - 图片预览
  - 文件下载
  - 缺失产物提示
- 失败行支持重新运行；不允许对正在运行的 Run 重试。
- 可选：对比两个 Run 的行级结果。

### 4.6 卸载与危险操作

- 卸载 Skill 前列出：
  - 将被删除的本地文件
  - 关联的 Template
  - 是否连带删除 Run
- 明确提示：飞书表格里的列不会被删除。
- `--all`、清空运行记录、全表重跑都需要输入确认或二次确认。

## 5. HTTP API 草案

所有响应使用统一结构：

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

失败时返回：

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "TABLE_MISMATCH",
    "message": "必填输入列已被删除",
    "action": "重新映射或恢复该列"
  }
}
```

### 资源接口

```text
GET    /api/status
GET    /api/skills
POST   /api/skills/load
GET    /api/skills/:ref
DELETE /api/skills/:ref

GET    /api/skills/:ref/analysis
PUT    /api/skills/:ref/io-schema

POST   /api/mappings/preview
POST   /api/mappings
GET    /api/templates
GET    /api/templates/:id
GET    /api/templates/:id/export

POST   /api/runs
GET    /api/runs
GET    /api/runs/:id
GET    /api/runs/:id/events      # SSE
POST   /api/runs/:id/cancel
POST   /api/runs/:id/retry

GET    /api/runs/:id/items/:recordId
GET    /api/runs/:id/artifacts/:recordId/:file
```

### API 约束

- 请求体中的路径必须在允许目录内。
- 所有外部命令使用 argv 数组执行，不拼接 shell 字符串。
- 所有写接口必须有 CSRF 防护或同源校验。
- 产物下载必须校验 Run、record 和文件路径。
- 错误码要稳定，UI 不依赖错误文案做判断。

## 6. 状态与持久化

### 持久化约定

- `.data/skills/`、`.data/templates/`、`.data/runs/`、`.data/tmp/` 仍是唯一真相。
- Run 启动时立即创建 `.data/runs/<run_id>/run.json`，状态先写 `queued`，再写 `running`。
- 每完成一个 RunItem，原子更新 `run.json`，避免服务崩溃后整次运行不可见。
- 活跃任务在内存中维护，服务重启时把未完成的 Run 标记为 `interrupted`。
- SSE 客户端首次连接时先发送当前快照，再发送增量事件。
- 本方案不做 SQLite 索引；当 Run 列表扫描明显变慢时，再增加只读索引。

### 建议的 Run 状态

```text
queued → running → completed
                 ├→ partial
                 ├→ failed
                 ├→ canceled
                 └→ interrupted
```

## 7. Milestones

### M1：只读控制台（已实现）

**目标**：零写入风险地验证 API、文件扫描和页面结构。

任务：

- [x] 增加 `src/server/` 和 `src/web/` 骨架。
- [x] 从文件系统读取 Skill、Template、Run 列表。
- [x] 展示 Run 详情、RunItem、日志和产物。
- [x] 增加最基本访问鉴权。
- [x] 为读取接口写 fixture 测试。

验收：

- [x] 不执行任何写操作也能看到当前 SkillApp 的全部状态。
- [x] 日志和产物可安全下载。
- [x] 服务重启后页面内容不变。

启动：

```bash
node src/server/index.js --port 4173 --token '<token>'
```

### M2：执行控制台

**目标**：把 `run-template` 变成可观测、可取消的异步任务。

任务：

- 抽出 `runTemplate` core service，CLI 变成薄壳。
- 引入单 worker Job Runner。
- Run 启动时落盘，执行中持续更新进度。
- 增加 SSE 事件流。
- 支持 pending 预览、dry-run、all、record-id。
- 增加 Template 级锁、取消和失败行重试。
- 处理进程退出、服务重启和中断恢复。

验收：

- 页面可以启动一次运行并实时看到每行阶段。
- 刷新页面后仍能恢复进度。
- 取消后不会继续写表。
- 同一 Template 不能并发运行两次。

### M3：初始化与映射向导

**目标**：完成浏览器内的 Skill 装载、分析确认和表格映射。

任务：

- Skill 路径白名单、zip 上传和重新装载。
- 展示分析报告与待确认项的建议、依据、默认。
- 允许编辑 `io-schema.json` 并保存。
- 增加 mapping dry-run 预览。
- 增加显式确认后的 map apply。
- 增加 Template 详情和卸载影响预览。
- 给映射、卸载、全表运行增加危险操作确认。

验收：

- 用户不执行 CLI 也能完成一次初始化。
- 映射前能看到所有表格变更。
- 未确认时不会修改飞书表格。
- 卸载时能明确知道会影响哪些本地文件。

### M4：加固

**目标**：让 Web UI 可长期运行。

任务：

- 统一错误码和可操作提示。
- 增加上传大小、路径穿越、命令注入、产物下载的测试。
- 增加 Run 保留策略和手动清理。
- 增加崩溃恢复测试和日志轮转。
- 评估 Run 数量增长后的索引方案。
- 评估一个 Skill 映射多张表的 Template 命名方案。

## 8. 暂不纳入

- 多用户、RBAC、按用户隔离的飞书 OAuth。
- 定时执行、Webhook 触发、失败通知。
- 多 worker、并发执行和行级租约。
- 对象存储和远程产物访问。
- Web 内直接编辑飞书表结构。
- 在 Web 服务中运行完整 LLM 分析流程。

## 9. 需要先拍板的产品决策

1. **部署形态**：只允许本机访问，还是部署到服务器？建议先做单实例、可信环境。
2. **Skill 来源**：只允许服务器路径、上传 zip，还是同时支持 git URL？推荐先支持上传 zip 和允许目录。
3. **分析来源**：继续由 Agent 产出报告，还是 Web 内接 LLM？建议先只消费和展示 Agent 产物。
4. **飞书身份**：全站共用一个 `lark-cli` 身份，还是每个用户自己的身份？建议先用单身份。
5. **模板共享**：Template 继续只留在本机，还是支持导出/导入？建议先支持 JSON 导出。
