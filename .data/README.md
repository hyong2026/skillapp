# .data/

**内容层**：运行时会读写的一切数据都在这里，代码在 `src/`。
除各目录的 `README.md` 外，内容一律不进 Git。

一个 Skill 的一生正好对应下面几个目录：

```text
装载   skills/<Skill Name>/                              Skill 副本 + source.json（来源、指纹、描述）
分析   mappings/<Skill Name>.mapping.json                IO 契约草案（输入 / 输出 / 命令模板）
绑定   templates/<Skill Name>-<目标指纹>.template.json    Skill + 目标表 + 生效的 Mapping
执行   runs/<run_id>/                            Run、Run Item、日志与产物
过程   operations/<operation_id>/operation.json   异步操作状态（含 Run 的索引镜像）
```

| 目录 | 放什么 | 详细 |
|---|---|---|
| `skills/` | 已装载的 Skill 副本 | [skills/README.md](skills/README.md) |
| `mappings/` | 分析产出的 Mapping | [mappings/README.md](mappings/README.md) |
| `templates/` | Template（内含 Mapping） | [templates/README.md](templates/README.md) |
| `runs/` | Run、Run Item、日志、产物 | [runs/README.md](runs/README.md) |
| `operations/` | 异步操作状态 | [operations/README.md](operations/README.md) |

## 三条约定

1. **文件系统是唯一真相**：没有数据库。删掉整个 `.data/` 就等于把 SkillApp 重置回空白——飞书表里的列和数据不受影响。
2. **JSON 状态文件一律「临时文件 + rename」原子更新**，读到的永远是完整的一份。
3. **名字可读**，不塞随机数：`<Skill Name>` 是 Skill 名（CLI 里叫 `ref`），`<Skill Name>-<目标指纹>` 是 Template 名（指纹取 base + table + view 的 sha256 前 8 位）。

## 为什么这里没有 package.json

装载进来的 Skill 可能是 Node、也可能是 Python——语言由 Skill 自己声明（Node Skill 想用 `require`，就自带一份带 `type` 的 `package.json`）。仓库根不替它决定。

📖 完整文档：仓库根 [`README.md`](../README.md)、[`docs/`](../docs/)（[架构](../docs/architecture.md)、[执行语义](../docs/run.md)、[GUI](../docs/gui.md)、[API](../docs/api.md)、[CLI](../docs/cli.md)）。
