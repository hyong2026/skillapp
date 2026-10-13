# .data/

内容层。这里放运行时会读写的数据，代码都在 `src/`。

```text
.data/
├── skills/       已装载的 Skill 副本
├── templates/    Template
├── mappings/     分析产出的 Mapping
├── runs/         Run、RunItem、日志和产物
└── operations/   Load、Analyze、Mapping、Unload、Run 操作状态
```

各子目录的具体说明见各自的 `README.md`。除这些说明文件外，内容一律不进 Git。

**这里不放 `package.json`**：装载进来的 Skill 可能是 Node、也可能是 Python，语言由 Skill 自己声明
（Node Skill 想用 `require` 就自带一份带 `type` 的 `package.json`，仓库根不替它决定）。
