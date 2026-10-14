# templates/

Template —— **可运行的定义**：Skill 内容指纹 + 目标表 + 生效的 Mapping + 限额。
**一个 Skill + 一张表（base + table + view）一份。**

```text
mappings/<ref>.mapping.json  →  map-table.js  →  templates/<ref>-<目标指纹>.template.json
   （人审过的契约）              （对齐表列、排顺序）
```

| 字段 | 是什么 |
|---|---|
| `template_id` | UUID，Run / Operations 引用它 |
| `skill` | `path`（`skills/<ref>`）+ 内容 `hash` + `entry` |
| `target` | `base_token` / `table_id` / `view_id` / `primary_field_id` |
| `mapping` | Mapping 的落地版：每条多了对齐结果 `field_id` |
| `limits` | `max_rows_per_run` / `timeout_s` |
| `archived_at` | 归档时间；有它 = 冻结 |

约定：

- 文件名 = `<ref>-<目标指纹>.template.json`，指纹取 `base_token | table_id | view_id` 的 sha256 前 8 位。**同一个 Skill 映射到不同表就是不同文件**；三元组完全一致时只更新原来那份（沿用 `template_id`）。
- **Run 只记 `template_id` 与发起时的 `template_name`**，所以改文件名不会断链。
- **归档 = 冻结**：文件留着、从 Templates 列表消失、不能再跑；Run 里按 `template_id` 仍能打开，解冻即恢复。
- 内容只保留执行必需字段，不写 `version` / `changelog`，也不写列名（运行时从表格读）。
- 它不进 Git，所以**来源记录也不进 Git**：克隆后必须重跑初始化才能恢复。

📖 见 [`docs/run.md`](../docs/run.md) 与 [`docs/architecture.md`](../docs/architecture.md)。

**本目录为空 = 还没初始化过任何 Template。**
