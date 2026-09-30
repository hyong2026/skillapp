---
name: analyze-skill-io
description: 读取一个本地 Agent Skill 的实现，产出结构化的 IO 契约（io-schema.json）与风险清单，供映射到飞书多维表格。当需要把已有 skill 转成 Template、或要确定某个 skill 的输入输出时使用。
---

# 分析 Skill 的 IO

把 skill 的接口从实现里提取出来，变成可审的结构化契约。

| | |
|---|---|
| **输入** | skill 根目录路径（含 `SKILL.md`） |
| **输出** | `io-schema.json` + 风险清单 |

## 原则：以实现为准

`SKILL.md` 只用于**定位入口**。参数、类型、默认值、错误行为一律从入口代码读出。

文档与实现不一致时视为 bug，逐条列入风险清单。典型：文档声称「按输出文件名后缀选择格式」，实现写死 `.png()`——用户选 JPG 会静默拿到 PNG。

## 步骤

1. 读 `SKILL.md`，定位入口（脚本 / CLI / 函数）
2. 读入口实现，列出全部参数：名称、短名、类型、必填性、默认值、取值范围
3. 对每个参数判定三项属性（见下）
4. 读实现的输出路径：成功输出什么；失败走 stdout / stderr / 退出码哪一条；错误能否结构化解析
5. 剔除输入回显——把输入原样返回的字段不应成为输出列
6. 写 `io-schema.json` 与风险清单

## 参数属性

| 属性 | 取值 | 判定依据 |
|---|---|---|
| `source` | `user` / `machine` | 执行器能否自行决定。输出路径、`--json` 属 `machine` |
| `scope` | `row` / `template` | 是否逐行变化。批次内恒定者属 `template` |
| `opens` | `values` / `free` | 取值是否可枚举 |

## 字段映射规则

| 参数 / 产物形态 | 目标类型 | 注意 |
|---|---|---|
| `machine` 类参数 | **不建列** | 最易犯的错：朴素推断会把它建成文本列 |
| 变长位置参数（多个文件） | attachment | |
| 枚举 + 默认值 | select（单选） | 默认值一并写进字段 |
| 自由文本 | text | 正则等校验留在 Mapping 层 |
| 数量 / 长度上限 | — | 写进 Mapping 的 `validate`，字段 schema 表达不了 |
| 布尔语义 | checkbox | 勾选框**不支持默认值**，未勾选即 false；skill 侧默认值为 true 时须显式覆盖两侧 |
| 产物为文件 | attachment | ≤20MB 单次上传；>20MB 必须分片（4MB/片，事务 24h） |
| 产物为标量 | number / text | 数值列必须可强制转换；转不了标失败，不得写脏数据 |

## io-schema.json

```jsonc
{
  "skill": { "ref": "image-merge", "runtime": "node", "entry": "scripts/main.js" },
  "inputs": [
    { "key": "images", "label": "待拼接图片", "type": "attachment",
      "multiple": true, "min_count": 2, "required": true,
      "source": "user", "scope": "row" },
    { "key": "direction", "label": "拼接方向", "type": "select",
      "options": ["horizontal", "vertical"], "default": "horizontal",
      "source": "user", "scope": "template" }
  ],
  "outputs": [
    { "key": "merged_image", "label": "拼接结果", "type": "attachment", "writes": "file" },
    { "key": "canvas_width", "label": "画布宽(px)", "type": "number", "from": "stdout.canvas.width" }
  ],
  "internal": [
    { "key": "output", "note": "执行器生成的临时路径，不暴露为用户字段" }
  ]
}
```

## 风险清单

必须覆盖：

- 文档与实现不一致之处，附证据
- 无法用字段类型表达的约束（数量、长度、正则）
- 跨字段约束（例：勾选「透明」同时选 JPG）
- 需要人拍板的取舍（例：颜色用保真文本框还是友好单选）
- 建议的 `row` / `template` 划分

## 交付前

**停下来等人确认。推断是建议，不是事实。**

缺这一步，第一个 Template 必然出错——`machine` 类参数就曾险些被建成用户列。