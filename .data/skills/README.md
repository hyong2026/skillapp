# skills/

装载进来的 Skill 副本。装载后这里是**运行时的唯一真相**——上游改了，必须重新装载才生效。

```bash
node src/cli/load-skill.js /path/to/skill      # 目录名就是 ref
```

| 路径 | 是什么 |
|---|---|
| `<Skill Name>/SKILL.md` | Skill 本体（写给 Agent 看的那份说明书） |
| `<Skill Name>/source.json` | 装载记录：来源绝对路径、内容指纹 `hash`、`SKILL.md` frontmatter 里的 `description`、`loaded_at` |
| `<Skill Name>/node_modules/` | 一并复制（Skill 的运行契约），但不进 Git |
| `<Skill Name>/…` | Skill 自己的脚本与资源 |
| `package.json` | 模块系统边界：**不声明 `type`**，第三方 Skill 按 Node 默认模块系统解析（见 [../README.md](../README.md)） |

约定：

- `ref` = 源目录最后一段，必须匹配 `[A-Za-z0-9._-]+`；装载时整目录原子替换。
- **版本锚点在 Template 里**（`skill.hash`），不在本目录——这里只有当前这一份。
- 语言中立：可能是 Node，也可能是 Python；模块系统不替 Skill 决定（见 [../README.md](../README.md)）。

📖 装载、分析与执行的完整语义见 [`docs/run.md`](../docs/run.md) 与 [`docs/cli.md`](../docs/cli.md)。

**本目录为空 = 还没装载任何 Skill，执行会被拒绝。**
