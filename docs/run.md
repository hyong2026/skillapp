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

命令模板的三种写法：

| 写法 | 含义 |
|---|---|
| `{key}` | 位置参数；值为空/未定义会报错 |
| `{key...}` | 展开成多个位置参数（一组文件） |
| `{--flag key}` | 成对参数；值为空或该列已被删除时**整对省略** |

## 写回

- 标量输出：按 `from` 表达式（只支持 `stdout.xxx`，可带 `/ 1024` 这类除法）取值后一次性 `record-batch-update`。
- 附件输出：先清空该列再逐个上传（上传是追加语义）。
- **没有输出列也能跑**：照常读输入、执行 Skill，只是不回写，Run 记为 `completed`。
- 未映射（`mapped: false`）的列不读、不写；`cmd` 里以 `{key}` 形式用到未映射的输入会在运行前直接报错。

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
    └── logs/
        ├── stdout.log           Skill 的 stdout 原文
        └── stderr.log           Skill 的 stderr 原文
```

- 日志**原样落盘**，不做 JSON 包装——它首先是给人看的；图形界面直接展示这两份文本（带行号）。
- stdout 只在**有输出列**时解析成 JSON 取字段；`stdout` 不是 JSON 时该行失败并记 `error`。
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
    { "key": "tiles", "label": "切片", "type": "attachment", "from": "stdout.files[].path" },
    { "key": "tile_count", "label": "切片数", "type": "number", "from": "stdout.grid.total", "round": 0 }
  ],
  "limits": { "max_rows_per_run": 200, "timeout_s": 300 },
  "skill_hash": "sha256:…", "updated_at": "…"
}
```

支持的类型：`text / number / datetime / checkbox / attachment / select`。
模板（Template）里同样一份 Mapping，但每个条目多了对齐结果 `field_id`，并带 `template_id` / `created_at` / `target`。

## 预览（dry-run）

`POST /api/templates/:id/preview` 与 `--dry-run` 只核对：会处理哪些行、共几行、哪些绑定列在表里已经找不到（`dropped`）、目标表是谁。不执行、不回写、不产生 Run。
