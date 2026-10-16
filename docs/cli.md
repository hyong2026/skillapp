# CLI

四条命令：装载、绑定、执行、卸载。它们与图形控制台共用 `src/core/` 里的同一份业务逻辑，只是薄壳（参数解析 + 终端输出 + 退出码）。

```bash
node src/cli/load-skill.js   <Skill 根目录>
node src/cli/bind-table.js    --ref <ref> --url '<表格链接>'
node src/cli/run-template.js <template.json> [--incremental]
node src/cli/unload-skill.js <ref> [--with-runs]
```

**分析（Analyze）没有独立命令**：它要读任意实现、做类型取舍，只能是 Skill。由 Agent 用 [`.agents/skills/analyze-skill/`](../.agents/skills/analyze-skill/) 完成，产出 `.data/mappings/<Skill Name>.mapping.json`（图形界面里的 `Analyze` 按钮走的是同一个分析器）。

## 共同约定

- 启动时自动读取仓库根（或 `SKILLAPP_ROOT`）下的 `.env`，不覆盖 shell 里已有的变量。
- 出错时打印 `❌ <message>` 并以退出码 `1` 结束；成功为 `0`。
- 每个命令都支持 `-h / --help`。
- `ref` 由 Skill 目录名推导，必须是 `[A-Za-z0-9._-]+` 且不含 `.` / `..`。

## load-skill.js

```bash
node src/cli/load-skill.js /path/to/skill
```

- **目录名就是 Skill Name**（CLI 与落盘路径里叫 `ref`），装载后落在 `.data/skills/<Skill Name>/`。
- 目录必须包含 `SKILL.md`；默认完整导入（含 `node_modules`），跳过 `.git` / `.DS_Store`。
- 装载时：计算内容指纹写入 `source.json`（含来源路径、指纹、`SKILL.md` frontmatter 里的 `description`、装载时间），原子替换旧副本。
- 源目录与目标目录相同或互相包含时拒绝执行。

## bind-table.js

```bash
node src/cli/bind-table.js --ref <ref> --url '<表格链接>'
node src/cli/bind-table.js --ref <ref> --base <token> --table <id> --view <view_id>
node src/cli/bind-table.js --ref <ref> --url '<链接>' --dry-run
```

| 参数 | 说明 |
|---|---|
| `--ref <ref>` | 已装载的 Skill 名（对应 Skill Name），Mapping 默认读 `.data/mappings/<Skill Name>.mapping.json` |
| `--url <链接>` | 目标表格链接，需带 `table` 与 `view` 参数 |
| `--base/--table/--view` | 直接给 token，替代 `--url` |
| `--dry-run` | 只输出计划，不建列、不排顺序、不写文件 |

行为：对齐列（复用 / 新建）、按契约设列顺序、必要时把主字段改名为 `任务名称`，最后写 Template。
计划带 `plan_hash + diff`，写入前重新校验——表格结构在执行期间变了会拒绝写出。
同一个 Skill 绑定到不同表（base + table + **view**）会各生成一份 Template；三元组完全一致才原地更新。

## run-template.js

```bash
node src/cli/run-template.js .data/templates/<Skill Name>-<目标指纹>.template.json --incremental
node src/cli/run-template.js <template.json> --dry-run
```

| 参数 | 说明 |
|---|---|
| `--all` | 处理表内所有行（默认） |
| `--incremental` | 只处理工作版本或输入变化的行 |
| `--dry-run` | 只核对，不执行、不回写、不产生 Run 记录 |

执行细节（选行规则、写回、日志与产物）见 [run.md](run.md)。成功后终端会打印 `完成: N 成功 / M 失败` 与 `run.json` 的相对路径。

## unload-skill.js

```bash
node src/cli/unload-skill.js <ref>              # 只删本地内容层
node src/cli/unload-skill.js <ref> --with-runs  # 连关联 Run 一起删
node src/cli/unload-skill.js --all --yes        # 清空整个内容层
```

| 参数 | 说明 |
|---|---|
| `--with-runs` | 连引用这些 Template 的运行记录一起删（默认保留） |
| `--yes` | `--all` 的确认开关 |
| `--dry-run` | 只列出将要删的东西 |

删除的只是本地内容层：**飞书表格里的列与数据不会被删除**。

## 环境变量

`.env` 放在应用根目录（`SKILLAPP_ROOT`，默认仓库根），图形控制台与 CLI 共用：

```dotenv
# 图形控制台
SKILLAPP_WEB_TOKEN=<token>              # 非本机监听时必须；改动需重启

# 分析器（Analyze 按钮 / analyze-skill 调用）
SKILLAPP_ANALYZE_COMMAND=codex          # 默认 codex
SKILLAPP_ANALYZE_MODEL=<model>          # 可选，留空用命令自带默认
SKILLAPP_ANALYZE_REASONING_EFFORT=low   # low / medium / high
SKILLAPP_ANALYZE_TIMEOUT_MS=900000      # 默认 15 分钟
SKILLAPP_ANALYZE_ARGS='[]'              # 高级：完全自定义分析器参数（JSON 数组）；一旦设置，默认参数（含 -o 收结果、project_doc_max_bytes=0）全部失效，分析器需自己写出 mapping 文件

# 执行（Run）
SKILLAPP_RUN_CONCURRENCY=4              # 同一 Run 内同时跑几行，默认 4、上限 8；改完即时生效

# 内容层与依赖
SKILLAPP_ROOT=<dir>                     # 内容根，默认仓库根
SKILLAPP_DATA_DIR=<dir>                 # 内容目录，默认 <root>/.data
SKILLAPP_LARK_MODULE=<path>             # 替换 lark 实现（测试用）
```

图形控制台提供了这套配置的 HTTP 接口（白名单：`SKILLAPP_ANALYZE_COMMAND / _MODEL / _REASONING_EFFORT / _TIMEOUT_MS` 与 `SKILLAPP_RUN_CONCURRENCY`，写入仓库根 `.env` 并立即生效）；页面上的 **Settings** 目前只展示运行信息，见 [gui.md](gui.md#settings) 与 [api.md](api.md)。

## 做同一件事的三种入口

| 事情 | CLI | HTTP | GUI |
|---|---|---|---|
| 装载 | `load-skill.js` | `POST /api/skills` | Skills → `Load` |
| 分析 | Agent + `analyze-skill` | `POST /api/skills/:ref/analyze` | Skill 详情 → `Analyze` |
| 绑定 | `bind-table.js` | `POST /api/skills/:ref/bind` | Skill 详情 → `Bind Table` |
| 执行 | `run-template.js` | `POST /api/runs` | Template 详情 → `Run` |
| 卸载 | `unload-skill.js` | `DELETE /api/skills/:ref` | Skill 详情 → `Unload` |

接口细节见 [api.md](api.md)。
