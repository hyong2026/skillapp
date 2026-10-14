# templates/

Template 定义，**一个 Skill + 一张表（base + table + view）一份**。**内容不进 Git**，本文件除外。

由初始化流程生成：

```
analyze-skill-io  →  .data/mappings/<ref>.mapping.json
    ┊  人审
map-table.js      →  表格列对齐 + .data/templates/<ref>-<目标指纹>.template.json
```

Template 里记录 Skill 的内容指纹与来源提示，所以**它不进 Git 就等于来源记录也不进 Git**——克隆后必须重跑初始化才能恢复。

文件名 = `<ref>-<目标指纹>.template.json`，指纹取 `base_token | table_id | view_id` 的 sha256 前 8 位。同一个 Skill 映射到不同表就是不同文件；目标完全一致时只更新原来那份（`template_id` 沿用它）。内容只保留执行时必需的字段——`template_id`（UUID）、`created_at`、`skill`、`target`、`mapping`、`limits`，归档过再加一个 `archived_at`；不写 `version` / `changelog`，也不写列名（运行时从表格读）。

**归档（`archived_at`）是冻结**：文件留着、从 Templates 列表里消失、也不能再跑；Run 里按 `template_id` 仍能打开。解冻即恢复。

**本目录为空 = 尚未初始化任何 Template。**
