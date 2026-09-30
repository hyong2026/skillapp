# templates/

Template 与 Mapping 定义，一个 Skill 一份。**内容不进 git**，本文件除外。

由初始化流程生成：

```
analyze-skill-io  →  tmp/io-schema.json + 风险清单
    ┊  人审
map-table.js      →  表格列对齐 + templates/<ref>.json
```

Template 里记录 Skill 的内容指纹与来源提示，所以**它不进 git 就等于来源记录也不进 git**——克隆后必须重跑初始化才能恢复。

文件与 Skill 同名：`<ref>.json`。内容只保留执行时必需的字段——`template_id`（UUID）、`created_at`、`skill`、`target`、`mapping`、`limits`；不写 `version` / `changelog`，也不写列名（运行时从表格读）。

**本目录为空 = 尚未初始化任何 Template。**