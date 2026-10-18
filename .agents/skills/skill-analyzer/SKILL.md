---
name: skill-analyzer
description: 读取一个本地 Agent Skill 的实现，产出结构化的 Mapping（IO 契约）。当需要把已有 Skill 转成 Template、或要确定某个 Skill 的输入输出时使用。
---

# 技能分析器

把 Skill 的接口从实现里提取出来，变成可审的结构化契约。

这是第 2 步「分析」：**复制**由 `src/cli/load-skill.js` 管（第 1 步「装载」），而分析要判断，所以由你来读、来写。

产出是**一份可执行的 Mapping**。生成后可以进入第 3 步「绑定」（Mapping → 表格列 + Template，纯机械，交给 `src/cli/bind-table.js`）。

| | |
|---|---|
| **输入** | Skill 根目录路径（含 `SKILL.md`）；该 Skill 已装载（`node src/cli/load-skill.js <Skill 根目录>`） |
| **输出** | `.data/mappings/<ref>.mapping.json` |

文件名带 Skill 名，因为 SkillApp 可以同时装载多个 Skill——`.data/mappings/` 是单槽目录，不区分就会互相覆盖。整个 `.data/mappings/` 已被 Git 忽略。

## 原则：以实现为准

`SKILL.md` 只用于**定位入口**。参数、类型、默认值、错误行为一律从入口代码读出。

文档与实现不一致时视为缺陷，逐条列入风险清单。典型：文档声称「按输出文件名后缀选择格式」，实现写死 `.png()`——用户选 JPG 会静默拿到 PNG。

### prompt 型 Skill（文件清单里没有代码）

有些 Skill 本身就是提示词：`SKILL.md`（必要时加 `references/`）就是全部实现，没有可执行入口。

- **把 `SKILL.md` 当实现读**：参数、默认值、取值范围、产物都从它的说明、选项表、示例调用里取。
- `cmd` 用这个固定形态（把自然语言指令交给 `codex exec`，让它按 SKILL.md 干活；各输入写成「名称={key}」）。**整段指令必须用双引号包成单个 token** —— `cmd` 按空白切成 argv，不包引号的话后面的词会被当成多余的位置参数（运行时报 `unexpected argument`）：

  ```
  codex exec --skip-git-repo-check -c project_doc_max_bytes=0 -C {outdir} -s workspace-write "读取并严格遵循{skill.entry}的流程，内容={content}；风格={style}；…；以上留空或写 auto 表示由你自动选择；产物全部写入{outdir}；最后一条消息只输出一行 JSON：files 为产物绝对路径数组、count 为数量"
  ```

- 这类 Skill 没有结构化 stdout，产物是写进 `{outdir}` 的文件：所以**必须**在指令里要求"最后一条消息只输出一行 JSON"，形如 `{"files":["<绝对路径>", …],"count":N}` —— `files` 是**路径字符串数组**，于是输出列写 `from: "stdout.files[]"`（`attachment`）与 `stdout.count`（`number`），并在 `hint` 里注明"不是纯 JSON 时该行失败"。**别写 `stdout.files[].path`**：那是对象数组的写法，配路径数组会摊出一串 undefined，运行时报 `Expression resolved to no file paths`。单行耗时可能很长，`limits.timeout_s` 给足（例如 1800）。
- **要联网就加沙箱开关**：Codex 的沙箱默认把 agent 的 shell 断网，Skill 需要联网（生图、下载 URL、调外部 API）时，`cmd` 里必须再加 `-c sandbox_workspace_write.network_access=true`，否则请求直接被挡下（表现为 `000` / 连接失败）：

  ```
  codex exec --skip-git-repo-check -c project_doc_max_bytes=0 -C {outdir} -s workspace-write -c sandbox_workspace_write.network_access=true "…"
  ```
- **不要去读 SkillApp 自己的 `src/`**（执行器、`src/core/mapping.js` 的校验、有没有"prompt 运行器"都不是你要确认的事——本规则就是全部约束）。

## 生图：用内置的 image-generator

需要出图的 Skill（prompt 型或脚本型）**只用这一条通路**：

```
node "$SKILLAPP_IMAGE_CLI" --prompt "…" --out <路径>/01-cover.png [--size 1248x1664] [--ref <已生成的图>] [--json]
```

`SKILLAPP_IMAGE_CLI` 由 SkillApp 注入（脚本绝对路径）；别去猜 Codex 原生 `image_gen` 工具能不能用，也别自己写 HTTP。

- **prompt 型**：指令里写明"生图一律调用上面这条命令"，并要求"命令失败就立刻停、把 stderr 那行原因写进最后一条消息；不要排查环境、不要用 SVG/HTML 顶替"。最后一条消息原样用它的 JSON（`{"files":["<绝对路径>", …],"count":N}`），所以产物列写 `from: "stdout.files[]"`（`attachment`）+ `stdout.count`（`number`）。
- **脚本型**：在入口代码里 spawn 这条命令即可。
- 需要生图的 Skill **一定同时加上**上一节的 `-c sandbox_workspace_write.network_access=true`；参数与失败信息见 [`image-generator/SKILL.md`](../image-generator/SKILL.md)。

## 步骤

1. 读 `SKILL.md`，定位入口（脚本 / CLI / 函数）
2. 读入口实现，列出全部参数：名称、短名、类型、必填性、默认值、取值范围
3. 对每个参数判定三项属性（见下）
4. 读实现的输出路径：成功输出什么；失败走 stdout / stderr / 退出码哪一条；错误能否结构化解析
5. 剔除输入回显——被原样返回的输入不应成为输出列
6. 写 `.data/mappings/<ref>.mapping.json`

## 参数属性

| 属性 | 取值 | 判定依据 |
|---|---|---|
| `source` | `user` / `machine` | 执行器能否自行决定。输出路径、`--json` 属 `machine` |
| `scope` | `row` / `template` | 是否逐行变化。批次内恒定者属 `template` |
| `opens` | `values` / `free` | 取值是否可枚举 |

`machine` 类参数**不写进 `mapping.json`**；它们由 `cmd` 里的固定写法（如 `{outdir}`）承担。

### `required` 怎么定（只对输入）

判据只有一个：**这一格允不允许为空**。跟这个参数"看起来重不重要"无关，也跟"这列要不要保留"无关。

| 情况 | `required` |
|---|---|
| 空格就做不了：`cmd` 里是不可省略的 `{key}`，实现没有兜底，缺了就报错 | `true` |
| 有 `default`（空格就用默认值兜住） | `false` —— 有默认值就说明允许空，两个键不能同时出现 |
| 实现 / 文档 / Notes 说「可留空 / 可选 / optional / 不填则 … / 可整列为空」 | `false` |
| 只说「这一列要保留、别删列」，值可以为空 | `false` —— 列的存在 ≠ 必填 |
| `checkbox`（未勾选即 false） | 一般 `false`，除非实现要求必须显式选择 |

`hint`（界面上的 Notes）与 `required` 必须自洽：写了"可留空 / 可选"就不能标必填；标了必填就要写清空值会怎样（例如"缺少则整批失败"）。

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

文本列里带链接的格子，飞书会存成 `[标题](URL)`；**SkillApp 在执行前会把整格就是一个 Markdown 链接的值还原成裸 URL**，所以映射里不用为它写 `transform`，也不必要求用户把链接改成纯文本。

## cmd 模板语法

`cmd` 描述怎么调用这个 Skill，支持三种 token：

| 写法 | 含义 |
|---|---|
| `{key}` | 该输入的取值；未定义则报错——**必填参数**用这种 |
| `{key...}` | 位置参数：展开为数组，传多个文件；嵌在引号里的指令文本中则展开成**空格分隔**的列表 |
| `{--flag key}` | **成对参数**：值空或该列已被删除时整对省略——**可选参数**必须用这种，否则会留下悬空的 flag |

指令文本里的可选值留空就是空串（例如 `补充备注={notes}` 直接渲染成 `补充备注=`），不必为"可能没有值"另造写法。

执行器固定提供的变量：`{skill.entry}`、`{outdir}`。

执行时的约定：`{skill.entry}` 会展开成**绝对路径**，`{outdir}` 是该行 `artifacts/` 的绝对路径；**进程 cwd 是内容层根（`.data/`）**，不是 Skill 目录。所以 `cmd` 里的路径一律用这两个变量，不要依赖相对路径；Skill 要写文件就写 `{outdir}` 或 `/tmp`（lark-cli 只允许写 cwd / `/tmp` / `~/files`）。

## label 命名

`label` 只写标签本身，**不带前缀、不带必填标记**——列名由 `src/cli/bind-table.js` 按规范拼装：

```
＊in: 网格数       ← 必填输入
in: 输出格式       ← 可选输入
out: 切片数        ← 输出
```

前缀统一用小写 `in:` / `out:`，必填标记用全角 `＊` 紧贴 `in`。标签里的标点也用半角（如 `out: 每格宽 (px)` 而不是 `out: 每格宽（px）`），否则一行里两种宽度会显得不齐。

## mapping.json

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
    { "key": "tile_count", "label": "切片数", "type": "number", "from": "stdout.grid.total",
      "hint": "按网格数向下取整" }
  ],

  "limits": { "max_rows_per_run": 200, "timeout_s": 120 }
}
```

各键的含义：

- `required` —— 只对输入有意义；必填项的列名行首会加全角 `＊`（判定见上面「`required` 怎么定」）
- `default` —— 单元格为空时的取值；列被删除则不传该参数，由 Skill 自己决定。**有 `default` 的输入一定不是必填**
- `validate` —— `enum` / `min` / `max` / `count` / `min_count` / `max_count`
- `transform` —— 列值 → 命令行值 的映射（如 `PNG` → `png`）
- `hint` —— 写进列的 description，给人看；输入与输出都可以有（界面上的 `Notes` 列）
- `from` —— 从 stdout 取值。`stdout.a.b` 取值，`/ 1024` 可换算，段尾 `[]` 表示逐项取值（结果变成数组）
- `round` —— 保留小数位

## 取舍与默认

不单独输出 Markdown 报告，也不写 `questions`：**取舍直接落进 Mapping 本身**（列、类型、必填、options、transform、default），需要解释的写进该字段的 `hint`。

- 有多个可行选择时，直接采用最合适的那个，并让它在 Mapping 里可被执行——不要留成"待确认"。
- `default` 是列空值时的行为；取值与命令行的映射交给 `options` / `transform`。
- 风险、限制和跨字段影响写进相应字段的 `hint` 或 `validate`，不要重复生成独立报告。

## 交付前

**交付物是可直接执行的 Mapping，不生成独立报告。**

所有需要判断的取舍都必须**已经落进 Mapping**（含默认值），避免后续步骤再引入人工决策。

用户要求继续或进入绑定时，直接交给第 3 步：

```bash
node src/cli/bind-table.js --ref <ref> --url '<表格链接>'
```

它只消费这份契约、不重新判断。契约是一次性的，落库后即可丢弃——下次要改映射，重跑本 Skill 即可。
