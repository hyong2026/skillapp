# skills/

导入的 skill 副本。**内容不进 git**，本文件除外。

由导入命令生成，导入后 `skills/<name>/` 是运行时的唯一真相；上游改动**必须重新导入**才生效。

```bash
node bin/skill-import.js /path/to/skill --ref <name>
```

- 每次导入写入 `skills/<name>/import.json`（来源路径、内容指纹、导入时间；同样不进 git）。
- 版本锚点在 `templates/<name>.template.json` 的 `skill.hash`，不在本目录。
- `node_modules/` 由导入一并复制（skill 的运行契约），但不进 git。

**本目录为空 = 尚未导入任何 skill，`bin/run-template.js` 会拒绝运行。**