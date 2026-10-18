# mappings/

Mapping —— Skill 的 **IO 契约（草案）**：输入、输出与命令模板。
`skill-analyzer` 写它，`bind-table.js` 读它；界面上就是 Skill 详情里的 `IO Schema` 面板。

```text
skill-analyzer  →  mappings/<Skill Name>.mapping.json  →  bind-table.js  →  templates/…
                            ↑
                    面板里的改名 / 勾选 / 排序（即时保存）
```

| 字段 | 是什么 |
|---|---|
| `skill.entry` | 入口脚本，相对 Skill 目录 |
| `cmd` | 每行要跑的命令模板（`{skill.entry}`、`{key}`、`{key...}`、`{--flag key}`） |
| `inputs[]` / `outputs[]` | 契约条目：`key` / `label` / `type` / `required` / `default` / `validate` / `transform` / `hint`；输出多一个 `from` 表达式与可选 `round` |
| `mapped` | `false` = 该列不建、不读、不写；缺省即参与映射（必填输入不允许 `false`） |
| `skill_hash` / `updated_at` | 对应的 Skill 指纹与保存时间 |

约定：

- **一个 Skill 一份**（文件名带 `<Skill Name>`），同时装载多个 Skill 不会互相覆盖。
- 它**不是一次性文件**：每次绑定都读它、面板改动即时写回它；重新分析会覆盖它，但**保留用户勾掉的 `mapped: false`**。
- 小改：面板或直接编辑这份 JSON；大改：重新分析。

📖 结构详解见 [`docs/run.md`](../docs/run.md#mapping-的结构)。

**本目录为空 = 还没分析过任何 Skill（GUI 里点 `Analyze`）。**
