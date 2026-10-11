# tmp/

中间产物。**内容不进 Git**，本文件除外。

放两样东西，都是 `analyze-skill-io` 交给人工与 `map-table.js` 的交接物：

| 文件 | 是什么 |
|---|---|
| `.data/tmp/<ref>.io-schema.json` | IO 契约草案，`src/cli/map-table.js` 的输入 |
| `.data/tmp/<ref>.io-report.md` | 分析报告（含风险清单），**给人评审** |

```
analyze-skill-io  →  .data/tmp/<ref>.io-{schema.json,report.md}  →  map-table.js
                          ↑ 人在这里审；未回复按报告建议默认
```

文件名带 Skill 名——SkillApp 可以同时装载多个 Skill，不区分就会互相覆盖。

它是**一次性的**：`map-table.js` 消费完即可丢弃。下次要改映射，重跑分析即可——契约能从 Skill 的实现重新推导出来。

**本目录为空 = 没有正在进行的映射。**
