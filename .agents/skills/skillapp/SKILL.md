---
name: skillapp
description: SkillApp 的操作入口：装载 Skill、把它的 IO 绑定到飞书多维表格、执行 Template。当用户说「装载 / 导入 Skill」「绑定到多维表格 / 建列 / 出 Template」（也会认「映射到多维表格」）「执行 / 跑 Template / 跑一批」时使用。注意它不负责分析 Skill 的输入输出——那是 analyze-skill 的活。
---

# 操作 SkillApp

四个步骤。**本文件只回答「这一步该做什么」**，不复制各命令的选项——那些用 `-h` 查，免得维护第二份真相。

| # | 步骤 | 用户给什么 | 用户得到什么 |
|---|---|---|---|
| 1 | **装载** | 一个 Skill 路径 | 复制进 SkillApp |
| 2 | **分析** | —— | 一份 **Mapping**（IO 契约） |
| 3 | **绑定** | 一个飞书表格链接 | 表格列 + Template |
| 4 | **执行** | —— | 回写的结果 |

**闸门在绑定。** 装载与分析都不碰表格；只有绑定会改表格结构，按 Mapping 中的默认建议执行。

**一次只做一步。** 用户说「装载」就只装载；「分析」交给 `analyze-skill`；做完停下，**不要顺手进入绑定**。可以提议下一步，但别自己走进去。

## 1 装载

```bash
node src/cli/load-skill.js <源目录>
```

上游改动后**必须重新装载**才生效——它会覆盖 `.data/skills/<ref>/` 并重算内容指纹。指纹一变，旧 Template 就被执行器拒绝；这是故意的，在逼人复核绑定。

源目录的最后一段自动作为 `ref`，也是 Template 里 `skill.path` 的末段。

## 2 分析

交给 [`analyze-skill`](../analyze-skill/SKILL.md)：它读 Skill 实现，产出 `.data/mappings/<ref>.mapping.json`。
**分析没有命令行**——它要读任意实现、做类型取舍，只能是 Skill。

交付物是 Mapping：取舍直接落进去（列、类型、必填、default、transform），理由写进 `hint`——没有单独的待确认清单。

## 3 绑定

只在两种情况需要重跑：Skill 的 IO 变了，或表格结构变了。**它会改用户表格的结构**，所以只在该做的时候做。

跑之前确认 Mapping 已生成，且其中的默认建议可以直接执行。

```bash
node src/cli/bind-table.js --ref <ref> --url '<表格链接>'
```

契约默认读 `.data/mappings/<ref>.mapping.json`（由 `--ref` 推导），不用手写路径。

## 4 执行

**默认 `--incremental`**：只跑「工作版本或输入与最近一次成功运行不一致」的行；Skill、Mapping、目标或输入变了都会重跑，重复执行安全。

`--all` 会无视历史重跑全表，只在用户明确要求时用。行数多时先 `--dry-run` 看一眼解析出的命令。

## 清空 / 重来

```bash
node src/cli/unload-skill.js <ref>          # 卸载一个 Skill 和引用它的 Template
node src/cli/unload-skill.js --all --yes    # 清空整个内容层（引擎保留）
```

本地能清干净，**飞书表格里的列不会被删**——脚本不碰用户的表；要去掉得在表格里手工删，或换一张表。

运行记录默认保留（卸载再重装时 `--incremental` 的历史才不白攒）；要一起删就加 `--with-runs`。

## 状态在哪

| | |
|---|---|
| 运行记录（Run / RunItem） | `.data/runs/<run_id>/run.json` |
| 多维表格 | **只有输入列和输出列**，不含任何运行状态 |

失败的行会被 `--incremental` 一直捞出（它就是「最近一次没成功」）。要让某行退出待运行，只能修输入；要无视历史重跑全表用 `--all`。
