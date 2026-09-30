---
name: analyze-skill-io
description: 读取一个本地 Agent Skill 的实现，产出结构化的 IO 契约草案与一份分析报告（含风险清单）。当需要把已有 Skill 转成 Template、或要确定某个 Skill 的输入输出时使用。
---

# 分析 Skill 的 IO

把 Skill 的接口从实现里提取出来，变成可审的结构化契约。

这是第 1 步「装载」的后半。装载 = **复制** + **分析**：复制由 `bin/load-skill.js` 管，分析要判断，所以由你来读、来写。

产出是**一份给人评审的报告**。评审通过才进入第 2 步「映射」（契约 → 表格列 + Template，纯机械，交给 `bin/map-table.js`）。

| | |
|---|---|
| **输入** | Skill 根目录路径（含 `SKILL.md`）；该 Skill 已装载（`node bin/load-skill.js`） |
| **输出** | `tmp/<ref>.io-schema.json`（契约草案）+ `tmp/<ref>.io-report.md`（分析报告，给人评审）|

文件名带 Skill 名，因为 SkillApp 可以同时装载多个 Skill——`tmp/` 是单槽目录，不区分就会互相覆盖。整个 `tmp/` 已被 git 忽略。

## 原则：以实现为准

`SKILL.md` 只用于**定位入口**。参数、类型、默认值、错误行为一律从入口代码读出。

文档与实现不一致时视为缺陷，逐条列入风险清单。典型：文档声称「按输出文件名后缀选择格式」，实现写死 `.png()`——用户选 JPG 会静默拿到 PNG。

## 步骤

1. 读 `SKILL.md`，定位入口（脚本 / CLI / 函数）
2. 读入口实现，列出全部参数：名称、短名、类型、必填性、默认值、取值范围
3. 对每个参数判定三项属性（见下）
4. 读实现的输出路径：成功输出什么；失败走 stdout / stderr / 退出码哪一条；错误能否结构化解析
5. 剔除输入回显——被原样返回的输入不应成为输出列
6. 写 `tmp/<ref>.io-schema.json` 与 `tmp/<ref>.io-report.md`

## 参数属性

| 属性 | 取值 | 判定依据 |
|---|---|---|
| `source` | `user` / `machine` | 执行器能否自行决定。输出路径、`--json` 属 `machine` |
| `scope` | `row` / `template` | 是否逐行变化。批次内恒定者属 `template` |
| `opens` | `values` / `free` | 取值是否可枚举 |

`machine` 类参数**不写进 `io-schema`**；它们由 `cmd` 里的固定写法（如 `{outdir}`）承担。

## 字段映射规则

| 参数 / 产物形态 | `type` | 注意 |
|---|---|---|
| 变长位置参数（多个文件） | `attachment` | |
| 枚举 + 默认值 | `select` + `options` | 默认值一并写进字段 |
| 自由文本 | `text` | 正则等校验留在 `validate`，字段 schema 表达不了 |
| 数量 / 长度上限 | — | 写进 `validate` |
| 布尔语义 | `checkbox` | 勾选框**不支持默认值**，未勾选即 false；Skill 侧默认值为 true 时须在 `cmd` 里显式覆盖两侧 |
| 产物为单个文件 | `attachment` | ≤20MB 单次上传；>20MB 必须分片（4MB/片，事务 24h） |
| 产物为一组文件 | `attachment` | 同一格可容纳多个；单次上传上限 50 个，超出由执行器分批追加 |
| 产物为标量 | `number` / `text` | 数值列必须可强制转换；转不了标失败，不得写脏数据 |

## cmd 模板语法

`cmd` 描述怎么调用这个 Skill，支持三种 token：

| 写法 | 含义 |
|---|---|
| `{key}` | 该输入的取值；未定义则报错——**必填参数**用这种 |
| `{key...}` | 展开为数组，用位置参数传多个文件 |
| `{--flag key}` | **成对参数**：值空或该列已被删除时整对省略——**可选参数**必须用这种，否则会留下悬空的 flag |

执行器固定提供的变量：`{skill.entry}`、`{outdir}`。

## label 命名

`label` 只写标签本身，**不带前缀、不带必填标记**——列名由 `bin/map-table.js` 按规范拼装：

```
* In: 网格数       ← 必填输入
In: 输出格式        ← 可选输入
Out: 切片数       ← 输出
```

前缀是半角的，标签里也跟着用半角（如 `Out: 每格宽 (px)` 而不是 `Out: 每格宽（px）`），否则一行里两种宽度会显得不齐。

## io-schema.json

```jsonc
{
  "skill": { "entry": "scripts/main.js" },
  "cmd": "node {skill.entry} {image...} -n {grid} {--format format} -o {outdir} --json",

  "inputs": [
    { "key": "image", "label": "待切图片", "type": "attachment",
      "required": true, "validate": { "count": 1 }, "hint": "单张；支持 PNG/JPEG/WebP/TIFF" },
    { "key": "grid", "label": "网格数", "type": "number",
      "required": true, "validate": { "min": 1, "max": 10 } },
    { "key": "format", "label": "输出格式", "type": "select",
      "options": ["PNG", "JPG"], "default": "PNG",
      "validate": { "enum": ["PNG", "JPG"] }, "transform": { "PNG": "png", "JPG": "jpg" } }
  ],

  "outputs": [
    { "key": "tiles", "label": "切片", "type": "attachment", "from": "stdout.files[].path" },
    { "key": "tile_count", "label": "切片数", "type": "number", "from": "stdout.grid.total" }
  ],

  "limits": { "max_rows_per_run": 200, "timeout_s": 120 }
}
```

各键的含义：

- `required` —— 只对输入有意义；必填项的列名行首会加 `* `
- `default` —— 单元格为空时的取值；列被删除则不传该参数，由 Skill 自己决定
- `validate` —— `enum` / `min` / `max` / `count` / `min_count` / `max_count`
- `transform` —— 列值 → 命令行值 的映射（如 `PNG` → `png`）
- `hint` —— 写进列的 description，给人看
- `from` —— 从 stdout 取值。`stdout.a.b` 取值，`/ 1024` 可换算，段尾 `[]` 表示逐项取值（结果变成数组）
- `round` —— 保留小数位

## 分析报告

写成一份能直接给人评审的文件（`tmp/<ref>.io-report.md`），至少包含：

1. **契约草案** —— 列名 / 类型 / 必填 / 默认 / 从哪个参数来
2. **风险清单** —— 逐条列，每条说清**后果**与**处理**。必须覆盖：
   - 文档与实现不一致之处，附证据
   - 无法用字段类型表达的约束（数量、长度、正则、**顺序**）
   - 跨字段副作用（例：改格式会连带改变空白区域外观）
   - `cmd` 的结构依赖（某个列被删会让命令悬空）
   - 规模 / 超时这类兜底参数的取值依据
3. **`row` / `template` 划分**
4. **实测证据** —— 能跑就跑一遍装载后的副本，把你验证过的事实写进来
5. **待确认** —— 把需要人拍板的取舍集中成几个「一句话能回答」的问题

## 交付前

**停下来等人确认。推断是建议，不是事实。**

没有这个停顿，第一个 Template 必然出错——`machine` 类参数就曾险些被建成用户列。

确认后交给第 2 步：

```bash
node bin/map-table.js tmp/<ref>.io-schema.json --ref <ref> --url '<表格链接>'
```

它只消费这份契约、不重新判断。契约是一次性的，落库后即可丢弃——下次要改映射，重跑本 Skill 即可。