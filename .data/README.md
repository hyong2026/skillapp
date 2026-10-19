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

## 为什么 skills/ 里有一份 package.json

它是**模块系统边界**：只有一句 `//` 说明 + `private`，**不声明 `type`**，跟着仓库走（`.gitignore` 里 `!.data/skills/package.json`；清理内容目录后 `git checkout -- .data` 一起恢复，各目录 README 同理）。

- 仓库根声明了 `"type": "module"`——那是给 `src/`、`test/`、内置 Skill 脚本用的。`skills/` 装的是**第三方 Skill 代码**，模块系统不该由仓库决定：Node 只认**最近的** `package.json`，这一份把查找截断在 `skills/` 这一层，里面的 `.js` 仍按 Node 默认解析。
- 少了它就会出事：`skills/image-split/scripts/main.js` 是 `require('sharp')`、又没自带 package.json，会直接报 `require is not defined in ES module scope`。
- Skill 自带 package.json（想声明 `type` 也行）时以它为准——它离得更近。
- 代价是：边界文件"存在但没声明 `type`"时，Node 碰到 ESM / TS 文件会先按 CJS 试、失败再按 ESM 重解析，并打一条 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告。**Skill 源码不能改，所以执行器给 Skill 子进程注入 `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`**（只静音这一条，CJS / ESM 都不受影响，也不动内容指纹）。

📖 完整文档：仓库根 [`README.md`](../README.md)、[`docs/`](../docs/)（[架构](../docs/architecture.md)、[执行语义](../docs/run.md)、[GUI](../docs/gui.md)、[API](../docs/api.md)、[CLI](../docs/cli.md)）。
