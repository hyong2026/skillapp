# runs/

运行记录与产物。**内容不进 Git**，本文件除外。

每次执行产生一个 `.data/runs/<run_id>/`：

```text
.data/runs/<run_id>/
├── run.json
└── <record_id>/
    ├── downloads/
    ├── artifacts/
    └── logs/
        ├── stdout.json
        └── stderr.json
```

| 路径 | 是什么 |
|---|---|
| `run.json` | **整个 Run**：摘要 + `items`（逐行明细） |
| `<record_id>/downloads/` | 输入快照，可据此复跑 |
| `<record_id>/artifacts/` | 该行的产物 |
| `<record_id>/logs/stdout.json` | stdout 日志：`{ record_id, stream, data }` |
| `<record_id>/logs/stderr.json` | stderr 日志：`{ record_id, stream, data }` |

**这里是 SkillApp 唯一的状态层** —— 飞书多维表格里不存任何运行状态。一个 Run 一个文件，不再另存逐行明细。

```jsonc
{
  "run_id": "20260930-194727-86bc",
  "template_id": "c62d75ba-…",     // 指向 .data/templates/<ref>.json
  "skill_hash": "sha256:a19b…",    // 本次使用的 Skill 版本
  "work_hash": "sha256:7c31…",     // Skill + 命令 + 目标 + 生效映射的版本
  "trigger": "pending",            // all | pending | record-id
  "started_at": "…",
  "finished_at": "…",
  "status": "completed",           // completed | partial | failed
  "succeeded": 1,
  "failed": 0,
  "items": [                       // RunItem：每行一条
    {
      "record_id": "rec…",
      "status": "succeeded",       // succeeded | failed
      "stage": null,               // 失败发生在哪一步；成功为 null
      "ms": 404,
      "error": null,
      "input_hash": "0fdc20aaa60db75a"
    }
  ]
}
```

`stage` 取值 `validate` / `exec` / `upload` / `writeback`。区分它是因为**重试价值不同**：`validate` 失败是输入不合规，重试没有意义；后三者才值得重试。

`stdout.json` / `stderr.json` 里的 `data` 始终是 JSON 值：合法 JSON 原样保留（标量会包成 `{ "value": ... }`），非 JSON 文本包成 `{ "raw": "..." }`。

`--pending` 读这里的历史，判断该行的**最近一次成功运行**是否使用同一工作版本且输入一致。旧 Run 没有 `work_hash` 时会重跑一次。

只看最近一次：若改用「历史上任意一次成功」，把输入改回旧值会被误判为已完成，而表里的输出其实是另一组输入产生的。

**本目录为空 = 从未运行过。**

注意：本目录只增不减，且失败行会被 `--pending` 反复捞出（它就是「最近一次没成功」）。目前没有清理策略。
