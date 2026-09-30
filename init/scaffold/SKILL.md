---
name: scaffold-template
description: 把已确认的 IO 契约落到飞书多维表格并生成 Template：增量对齐列、设置列顺序、产出 template.json。当要把某个 skill 的输入输出变成可运行的 Template 时使用。
---

# 用 IO 契约生成 Template

## 前置

- 经人工确认的 `io-schema.json`（来自 `analyze-skill-io`）
- 目标 Base 的 `base_token` / `table_id`
- skill 已导入：`node bin/skill-import.js <源目录> --ref <ref>`
- `skills/` 与 `templates/` 不进 git，克隆后可能不存在；写文件前先建目录

## 铁律

1. **绝不重建表。** 增量对齐：有则改、无则建、类型冲突即停下报告。表内可能有用户数据。
2. **Base 只存 IO。** 不建状态列，不建 Run / RunItem 表，不写运行元数据——那些全在 `runs/`。
3. **绑 `field_id`，不绑字段名。** 名字随时会被改。
4. **列顺序必须显式设置。** 见下。
5. 每个写操作先 `--dry-run` 看一眼。

## 步骤

1. 读活的 schema：`+field-list`、`+view-get-visible-fields`（后者才有序）
2. 按类型映射表增量对齐输入列与输出列
3. 跳过状态层——Base 里只该有输入列、输出列，外加一个文本主字段作行名
4. 设列顺序：`+view-set-visible-fields`，主字段 → 输入列 → 输出列
5. 重读 `field_id`，写进 `templates/<ref>.template.json` 的 `mapping`
6. 自检：`node bin/run-template.js <template> --dry-run`——核对 skill 指纹、字段存在性与类型，并打印解析出的 argv

## 类型映射

| io-schema | Bitable 字段 JSON |
|---|---|
| `text` | `{"type":"text"}` |
| `text` + 超链接 | `{"type":"text","style":{"type":"url"}}` |
| `number` | `{"type":"number","style":{"type":"plain","precision":N}}` |
| `select`（单选） | `{"type":"select","multiple":false,"options":[…]}` |
| `select`（多选） | `{"type":"select","multiple":true,"options":[…]}` |
| `checkbox` | `{"type":"checkbox"}` |
| `attachment` | `{"type":"attachment"}` |
| `datetime` | `{"type":"datetime","style":{"format":"yyyy-MM-dd HH:mm"}}` |
| 关联 | `{"type":"link","link_table":"<table_id>"}` |

## Bitable 约束

| 约束 | 说明 |
|---|---|
| 主字段 | 必须为文本类；附件 / 数字不可作主字段 |
| `select` | 无 `single_select` / `multi_select`，用 `multiple` 区分 |
| 超链接 | 无独立类型，是 `text` + `style.type=url` |
| `attachment` | 无数量约束属性，`min_count` 只能留在 Mapping 层 |
| `checkbox` | 不支持默认值 |
| `default_value` | 仅支持 `text` / `number` / 静态 `select` / `datetime` / `user` |
| 列顺序 | `+field-list` 返回顺序随机，创建顺序也不保证。**只有 `+view-set-visible-fields` 的 `visible_fields` 有序，且同时控制可见性与顺序**；数组须包含所有应可见字段，漏掉即隐藏 |
| 建表 | `+table-create --fields` 的第一项即主字段 |
| `datetime` | 格式仅到分钟，无秒 |
| 附件写入 | 上传是**追加**语义，重跑前必须先清空目标格，否则累积 |

## 产出

- 对齐后的 Base 表结构
- `templates/<ref>.template.json`：skill 引用（`ref` + `hash` + `source_hint`，不含绝对路径）、`mapping`（field_id 绑定 + validate）、`invocation`、`writeback`、`limits`、`changelog`