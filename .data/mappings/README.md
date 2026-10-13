# mappings/

Mapping。**内容不进 Git**，本文件除外。

`analyze-skill-io` 在这里生成 Mapping，`src/cli/map-table.js` 消费它：

| 文件 | 是什么 |
|---|---|
| `.data/mappings/<ref>.mapping.json` | Mapping，`src/cli/map-table.js` 的输入 |

```
analyze-skill-io  →  .data/mappings/<ref>.mapping.json  →  map-table.js
```

文件名带 Skill 名——SkillApp 可以同时装载多个 Skill，不区分就会互相覆盖。

它是**一次性的**：`map-table.js` 消费完即可丢弃。下次要改映射，重跑分析即可。

**本目录为空 = 没有正在进行的映射。**
