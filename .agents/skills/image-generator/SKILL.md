---
name: image-generator
description: SkillApp 的通用生图入口：把一个 prompt（可选多张参考图）交给 .env 里配置好的 OpenAI 兼容图像后端，产出图片文件。任何 Skill——prompt 型（SKILL.md）或脚本型（入口代码）——需要生成图片时都用它。
---

# 图片生成器

生图在 SkillApp 里**只有这一条通路**，所有 Skill 共用。它是一层薄封装：把参数拼成本机官方 **`openai` CLI** 的命令（`openai images generate` / `images edit`），请求交给 CLI 去发 —— 端点、密钥、模型全部来自 `.env`：

| 变量 | 含义 |
|---|---|
| `SKILLAPP_IMAGE_BASE_URL` | OpenAI 兼容端点，例如 `https://api.example.com/v1`（必填） |
| `SKILLAPP_IMAGE_API_KEY` | Bearer 密钥（必填） |
| `SKILLAPP_IMAGE_MODEL` | 模型 ID，例如 `gpt-image-2.5-flare`（必填，命令行 `--model` 可覆盖） |
| `SKILLAPP_IMAGE_SIZE` | 默认尺寸，例如 `1248x1664`（可选） |
| `SKILLAPP_IMAGE_QUALITY` | 默认质量 `low` / `medium` / `high`（可选） |
| `SKILLAPP_IMAGE_TIMEOUT_MS` | 单次请求超时，默认 `180000`（可选） |
| `SKILLAPP_IMAGE_OPENAI_CLI` | `openai` 可执行文件路径（可选，默认从 `PATH` 找） |

前置条件：本机要装官方 `openai` CLI（≥ 1.30，带 `images` 子命令）。缺了会明确报 `openai CLI not found`。
这条通路**不依赖 Codex 的原生 `image_gen` 工具**：那个工具取决于运行时/provider 有没有配图像模型，经常不可用，不要去猜、也不要为了它反复试。

## 命令

```bash
node "$SKILLAPP_IMAGE_CLI" --prompt "一只橘猫，3:4 竖构图，扁平插画风" --out "$OUTDIR/01-cover.png"

# 系列图：第 1 张不带参考图，之后每张把已生成的文件当参考图传进去，形象才一致
node "$SKILLAPP_IMAGE_CLI" --prompt-file /tmp/prompt-02.md \
  --ref "$OUTDIR/01-cover.png" --size 1024x1536 --out "$OUTDIR/02-ending.png"
```

- `SKILLAPP_IMAGE_CLI` 是这支脚本的**绝对路径**，由 SkillApp 注入到每个 Skill 子进程。不在 SkillApp 里跑时用仓库路径 `<repo>/.agents/skills/image-generator/scripts/generate.js`。
- 成功：写出的**绝对路径**打到 stdout（多个文件每行一个）；`--json` 时给一行 `{"files":[...],"count":N,"model":...,"size":...,"refs":N}` ——prompt 型 Skill 的"最后一条消息只输出一行 JSON：files / count"可以直接照抄这行。
- 失败：stderr 一行原因，退出码 1。

## 参数

| 参数 | 说明 |
|---|---|
| `--prompt <text>` / `--prompt-file <path>` | 二选一，必填。画面要素全写进去——模型只看得到你写的内容 |
| `--out <path>` | 必填。写出的文件路径，目录会自动建；多张时第 2 张起自动加 `-2` / `-3` |
| `--ref <path>` | 参考图，可重复。**给了就走 edits**（多张一起传），不给就走 generations |
| `--size <WxH\|auto>` | 例如 `1248x1664`；gpt-image 系列支持任意 `WxH`（宽高都要是 16 的倍数、比例在 1:3–3:1 之间），标准尺寸是 `1024x1024` / `1024x1536`（竖）/ `1536x1024`（横） |
| `--quality <low\|medium\|high>` | 可选 |
| `--n <N>` | 一次要几张，默认 1 |
| `--model <id>` | 覆盖 `SKILLAPP_IMAGE_MODEL` |
| `--json` | 输出一行 JSON（files / count / model / size / refs） |
| `--dry-run` | 只打印要发的请求（端点、模型、尺寸、参考图、prompt 字数），不发请求、不花钱 |

## 用在 prompt 型 Skill 里

1. **shell 默认没有外网**：Codex 的沙箱把网络关了，生图请求会被挡下。跑 Skill 的 `cmd` 必须带上
   `-c sandbox_workspace_write.network_access=true`
   （加上之后 Codex 会显示 `sandbox: workspace-write … (network access enabled)`）。
2. 系列图按上面的顺序生成：先第 1 张，再用 `--ref` 串下去。
3. 生图命令**失败就立刻停**：把 stderr 那一行原因写进最后一条消息（或 stderr）后结束。不要排查环境、不要换别的生图方式、**不要用 SVG / HTML / canvas 顶替**——产物必须是真正的位图。
4. prompt 里不要写密钥，密钥只存在于 `.env`。

## 用在脚本型 Skill 里

入口代码直接 spawn 上面的命令即可（Node / Python / shell 都行）：

```js
const { spawnSync } = require('node:child_process');
const cli = process.env.SKILLAPP_IMAGE_CLI;                 // SkillApp 运行时注入
const run = spawnSync(process.execPath, [cli, '--prompt', prompt, '--out', out, '--json'], { encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr.trim());   // 成功时 run.stdout 就是那行 files/count JSON
```

（也可以只读 `SKILLAPP_IMAGE_*` 自己发请求，但改后端就得跟着改 Skill——推荐前者。）

## 出错怎么读

| stderr | 原因 |
|---|---|
| `image backend is not configured: …` | `.env` 里少了那几个变量 |
| `openai CLI not found: …` | 本机没装官方 `openai` CLI（或不在 `PATH` 上） |
| `image generation failed: Request failed (401 Unauthorized). …` | `BASE_URL` 或 `API_KEY` 不对 |
| `image generation failed: … ` | 中转站不认这个 `MODEL`、`--size` 不被支持，或密钥没权限（CLI 的报错原样带出来） |
| `image generation timed out after …ms` | 单张太慢，调 `SKILLAPP_IMAGE_TIMEOUT_MS` |
