# skills/

导入的 Skill 副本。**内容不进 Git**，本文件除外。

由装载命令生成。装载后 `skills/<name>/` 是运行时的唯一真相；上游改动**必须重新装载**才生效。

```bash
node bin/load-skill.js /path/to/skill --ref <name>
```

- 每次装载写入 `skills/<name>/source.json`（来源路径、内容指纹、装载时间；同样不进 Git）。
- 版本锚点在 `templates/<ref>.json` 的 `skill.hash`，不在本目录。
- `node_modules/` 由导入一并复制（Skill 的运行契约），但不进 Git。

**本目录为空 = 尚未导入任何 Skill，`bin/run-template.js` 会拒绝运行。**