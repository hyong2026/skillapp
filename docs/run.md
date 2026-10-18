# 执行语义（Run）

一次 Run = 读表 → 逐行跑 Skill → 回写结果。状态只落在 `.data/runs/`，**飞书表里只有 IO 数据**。

## 触发与选行

| trigger | 选行规则 |
|---|---|
| `incremental`（默认） | 没跑过、上次失败、或工作版本 / 输入与最近一次成功运行不一致 |
| `all` | 全表重跑 |

判定只看**最近一次**运行，不看「历史上是否曾经成功」——否则把输入改回旧值会被误判为已完成，而表里的输出其实是另一组输入的产物。

两个指纹（都带 `sha256:` 前缀，长度 16）：

- `input_hash`：该行**输入单元格**的指纹（附件算 `file_token`，换图即失效）。
- `work_hash`：**Skill hash + 目标表 + 命令模板 + 生效的输入/输出映射**。任一项变化，相关行下次增量都会重跑。

副作用：删掉某个输入列、或把某列改成未映射，都会改变指纹，相关行会在下次增量时**重跑一次**。

## 一行一次子进程

每行都在**独立子进程**里跑 `mapping.cmd`，约定三条：

- `{skill.entry}` 展开成**绝对路径**；`{outdir}` 是该行在 Run 目录里的 `artifacts/`（同样是绝对路径）。
- **子进程的 cwd 是内容层根**（`.data/`），不是 Skill 目录。这样 Skill 自己调用 `lark-cli` 时，写进 `.data/runs/...` 的文件才落在它的写盘白名单里（lark-cli 只允许写 cwd / `/tmp` / `~/files`）。
- Skill 需要临时文件就写 `{outdir}` 或 `/tmp`，别依赖相对路径。
- 需要生图用宿主注入的入口 `node "$SKILLAPP_IMAGE_CLI" …`（配置见 [cli.md](cli.md#通用生图agentsskillsimage-generator)）；**prompt 型的 `cmd` 还要带 `-c sandbox_workspace_write.network_access=true`**，否则沙箱断网、请求发不出去。

命令模板的三种写法：

| 写法 | 含义 |
|---|---|
| `{key}` | 位置参数；值为空/未定义会报错 |
| `{key...}` | 展开成多个位置参数（一组文件） |
| `{--flag key}` | 成对参数；值为空或该列已被删除时**整对省略** |

prompt 型 Skill 的整段指令带引号，是**一个** token：那里没有 argv 的位置概念，占位符就地替换成文本——`{key}` 取标量（数组用逗号连接），`{key...}` 展开成**空格分隔**的列表，取不到值渲染成空串（默认留空是它的常态，如 `参考图=` / `补充备注=`）。必填输入缺失仍会在校验阶段报 `… is required`。

`cmd` 是纯文本模板，写错只会在某一行跑起来时才炸。所以 **Run 与 Preview 之前都会先扫一遍 `cmd`**：整块却不成形的占位符（如 `{--format}`）、引用了不存在的变量、位置参数用的是未映射的列，都在开跑前就拒绝，不会留下一个 Failed 的 Run。

## 并发

同一 Run 内默认**同时跑 4 行**：开 N 个 worker 抢同一个行号游标，一行跑完再领下一行。

- 并发数来自 `SKILLAPP_RUN_CONCURRENCY`（`.env`，或 `PUT /api/settings`；默认 4，上限 8），**每次 Run 开始时读取**：走 Settings 接口改，下一个 Run 就生效（手改 `.env` 仍需重启服务）。
- 行与行之间没有共享状态：各读自己的单元格、各写自己的记录、产物在自己的 `<record_id>/artifacts/` 里；附件列也是"清自己那一格再上传"，所以不会互踩。
- 飞书调用分两类：**按行**发生的（下载附件、回写、上传）走异步的 `larkAsync`，所以表 IO 也并行；**整表只做一次**的（`record-list`、`preflight` 的 `field-list`）走同步的 `lark`，在行开跑之前就做完了。同一行的多个附件也是一起下（`Promise.all`）。
- 进度按完成数递增（`run.completed`），`item-started` / `item-finished` 事件会交错推送，行序仍按表格顺序落在 `run.json`。
- **行内的意外错误只算这一行失败**（例如飞书 CLI 抛错、`cmd` 拼不出来）：其余行照跑，Run 正常收尾。Run 级失败（worker 崩了、服务重启、取消）也只把 Run 置终态——同一次落盘会把所有还挂在 `queued` / `running` 的行一起收敛（`failed` / `interrupted` / `canceled`）并重算计数，所以不会出现「Run Failed 但 Item 还在 Running」。

## 断点续跑

Retry / 再跑一次增量时，**已经成功的行本来就不会被选中**；这里说的是另一半——上次 **Skill 已经跑完、只是回写失败**的行（列类型不对、授权过期、`from` 表达式写错…）：重试时不该再把贵的 Skill 跑一遍。

- 每个可选中的条件都满足才续：上次**失败**、输入指纹与 **exec 版本**（Skill + 命令 + 目标 + 输入）没变、`<record>/stdout.json` 还在（说明 Skill 跑完了）、这次要回写的产物文件都还在。
- 续跑 = 跳过 校验 / 下载 / 执行，把上次的产物**硬链接**（跨卷则复制）进这次 Run 的行目录，然后按**解析后的 `stdout.json`** 重新回写。所以"把 `stdout.files[].path` 改成 `stdout.files[]` 再重试"这种修法，不必重新生图。
- 只要有一条不成立就老实全量重跑：换了输入、换了 Skill 或 cmd、上次 Skill 中途失败、产物被删、或者用 `--all`（All Rows）跑——全量语义就是**无条件重跑**。
- 这一行会记 `resumed_from: <旧 run_id>`，UI 上显示为 `Resumed From`；日志里也留一句 `[skillapp] resumed from …`，免得看日志的人以为它什么都没干。

## 写回

- 标量输出：按 `from` 表达式（只支持 `stdout.xxx`，可带 `/ 1024` 这类除法）取值后一次性 `record-batch-update`。
- 附件输出：先清空该列再逐个上传（上传是追加语义）。
- **没有输出列也能跑**：照常读输入、执行 Skill，只是不回写，Run 记为 `completed`。
- 未映射（`mapped: false`）的列不建、不读、不写，**也不写进 Template**；`cmd` 里以 `{key}` 形式用到模板里没有的输入会在运行前直接报错。

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
| 删掉非必填输入列 | 从映射中剔除；对应参数**整对省略**，Skill 用它自己的默认行为 |
| 删掉输出列 | 不再回写该列；全删也一样 |
| 删掉必填输入列 | **拒绝运行**，报明确的错 |
| 列还在但类型变了 | **拒绝运行** |

**链接列的归一**：飞书会把文本列里的 URL 存成 `[标题](URL)`。执行器解析输入时会把整格就是一个 Markdown 链接的值还原成裸 URL 再传给 Skill，所以映射里不必为它写 `transform`，Skill 收到的永远是裸 URL。

## 日志与产物

```text
.data/runs/<run_id>/
├── run.json                     Run 摘要 + 逐行 items
└── <record_id>/
    ├── downloads/               输入附件快照
    ├── artifacts/               该行的产物（{outdir}）
    ├── stdout.json              Skill 解析后的输出（回写失败时续跑靠它，也方便排查"到底吐了什么"）
    └── logs/
        ├── stdout.log           进程的 stdout 原文
        ├── stderr.log           脚本型 Skill 的 stderr 原文
        └── live.log             prompt 型 Skill 的实时进度（[msg] / [cmd] / [error]）
```

- 日志**原样落盘**，不做 JSON 包装——它首先是给人看的；图形界面直接展示这些文本（带行号）。
- **prompt 型 Skill**（入口是 `SKILL.md`，cmd 走 `codex exec`）由执行器补上 `--json`：stdout 变成
  "一行一个事件"的 JSONL，`live.log` 再把它整理成只值得看的那几类（模型的进度说明、跑的命令、
  报错），会话原文与工具输出都不进日志。答案取**最后一条 agent 消息**，所以 Mapping 里
  `from: stdout.…` 的写法不用变。
- 回写只在**有输出列**时解析答案；答案不是 JSON 时该行失败并记 `error`。
- 产物既回写进表格，也在本机留一份；界面上的 Artifacts 卡片按相对路径读取。

`run.json` 里的关键字段：

```jsonc
{
  "run_id": "20260930-194727-86bc",
  "template_id": "c62d75ba-…",
  "template_name": "image-merge-7417ead8",  // 发起时写死，之后不反查
  "skill_hash": "sha256:a19b…",
  "work_hash": "sha256:7c31…",
  "trigger": "incremental",
  "status": "completed",
  "items": [
    { "record_id": "rec…", "status": "succeeded", "stage": null, "ms": 404, "error": null, "input_hash": "sha256:0fdc20aaa60db75a" }
  ]
}
```

## Mapping 的结构

`.data/mappings/<Skill Name>.mapping.json` 是分析产物，也是 `bind-table.js` 的输入；写进 Template 后就是运行契约。

```jsonc
{
  "skill": { "entry": "scripts/main.js" },          // 入口相对 Skill 目录
  "cmd": "node {skill.entry} {image...} -n {grid} -o {outdir} --json",
  "inputs": [
    { "key": "image", "label": "待切图片", "type": "attachment", "required": true,
      "validate": { "count": 1 }, "hint": "……" },
    { "key": "format", "label": "输出格式", "type": "select", "required": false,
      "options": ["PNG", "JPG"], "default": "PNG", "transform": { "PNG": "png" } },
    { "key": "prefix", "label": "文件名前缀", "type": "text", "mapped": false }  // 不建列、不读、不写
  ],
  "outputs": [
    // 元素是对象（有 path 字段）就用 stdout.files[].path；元素本身就是路径字符串就用 stdout.files[]。
    // 写反了会摊出一串 undefined，运行时报 `Expression resolved to no file paths`。
    { "key": "tiles", "label": "切片", "type": "attachment", "from": "stdout.files[].path" },
    { "key": "tile_count", "label": "切片数", "type": "number", "from": "stdout.grid.total", "round": 0 }
  ],
  "limits": { "max_rows_per_run": 200, "timeout_s": 300 },
  "skill_hash": "sha256:…", "updated_at": "…"
}
```

支持的类型：`text / number / datetime / checkbox / attachment / select`。
模板（Template）里的 Mapping **只保留已映射的条目**（未勾选的不进），每个条目多了对齐结果 `field_id`，并带 `template_id` / `created_at` / `target`。

## 预览（dry-run）

`POST /api/templates/:id/preview` 与 `--dry-run` 只核对：会处理哪些行、共几行、哪些绑定列在表里已经找不到（`dropped`）、目标表是谁。不执行、不回写、不产生 Run。

图形控制台的 **Run** 走的就是这条路：点 Run 先预览一次，弹框固定列出 `Lark Base URL / Trigger / Rows in table / Rows to process`（未加载出来时是 `—`，高度一开始就固定），`All Rows` 勾选也在弹框里、切换即重新预览（只刷新 Trigger 与行数），确认后再提交真正的 Run。
