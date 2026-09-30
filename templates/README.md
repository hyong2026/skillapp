# templates/

Template 与 Mapping 定义，一个 skill 一份。**内容不进 git**，本文件除外。

由初始化流程生成：

```
init/analyze  →  io-schema.json + 风险清单
    ┊  人审
init/scaffold →  Base 列对齐 + templates/<ref>.template.json
```

Template 里记录 skill 的内容指纹与来源提示，所以**它不进 git 就等于来源记录也不进 git**——
克隆后必须重跑初始化才能恢复。

命名约定：`<skill-ref>.template.json`。

**本目录为空 = 尚未初始化任何 Template。**