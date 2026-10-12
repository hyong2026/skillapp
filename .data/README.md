# .data/

内容层。这里放运行时会读写的数据，代码都在 `src/`。

```text
.data/
├── skills/       已装载的 Skill 副本
├── templates/    Template 与 Mapping
├── runs/         Run、RunItem、日志和产物
├── operations/   Load、Analyze、Mapping、Unload 操作状态
└── tmp/          分析生成的 IO Schema
```

各子目录的具体说明见各自的 `README.md`。除这些说明文件外，内容一律不进 Git。
