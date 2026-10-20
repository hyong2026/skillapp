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
| `uploads/` | 上传暂存（会话期间的文件副本，commit 后由 worker 清掉；服务启动时清超过 12 小时的残留） | — |

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

## 依赖：不进源码、各装一份、首次使用时装

- **装载只搬源码**：`node_modules`、`__pycache__`、`.venv` / `venv` 一律不复制（`load-skill.js` 的 `SKIP`），它们也不进内容指纹（`skill-hash.js` 的 `IGNORE`）—— 所以同样的源码，从路径导入和从浏览器上传，指纹完全一致。
- **声明文件属于源码**：`package.json` / `package-lock.json` / `requirements.txt` / `pyproject.toml` 要跟着走，否则无从安装。
- **依赖装进 Skill 自己的目录**：Node 装 `skills/<Skill Name>/node_modules`，Python 装 `skills/<Skill Name>/.venv`。为什么不能"集中一份"：Node 的 ESM `import` **不吃 `NODE_PATH`**，只有入口祖先链上的 `node_modules` 才算数 —— 想隔离就只能各放一份；不隔离的代价是跨 Skill 的同名包只能 semver 合并。Python 运行时由执行器把 `.venv/bin` 前置到 `PATH`（见 `venvEnv`）。
- **首次使用时装**：装载不装（不因网络失败而失败），第一次 `Analyze` 时自动装；`npm` 一律带 `--ignore-scripts`（postinstall 就是执行第三方代码）。装失败会写进 `source.json` 的 `deps`，Run 的预检也会明确拦住并告诉你去 Analyze。
- **没有声明就什么都不装**：prompt 型 Skill（只有 `SKILL.md`）本来就没有依赖，这是常态；但**脚本型 Skill 用了第三方包却忘了写 `package.json`，跑起来会报缺包** —— 那是上游该补的东西，SkillApp 不会去猜。

📖 完整文档：仓库根 [`README.md`](../README.md)、[`docs/`](../docs/)（[架构](../docs/architecture.md)、[执行语义](../docs/run.md)、[GUI](../docs/gui.md)、[API](../docs/api.md)、[CLI](../docs/cli.md)）。
