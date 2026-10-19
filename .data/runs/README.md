# runs/

**运行记录与产物**。每次执行产生一个 `.data/runs/<run_id>/`。

```text
runs/<run_id>/
├── run.json                 Run 摘要 + items（逐行明细）
└── <record_id>/
    ├── downloads/           输入附件快照
    ├── artifacts/           该行的产物（{outdir}）
    ├── stdout.json          Skill 解析后的输出（回写失败时续跑靠它）
    └── logs/
        ├── stdout.log       进程的 stdout 原文
        ├── stderr.log       脚本型 Skill 的 stderr 原文
        └── live.log         prompt 型 Skill 的实时进度（[msg] / [cmd] / [error]）
```

**这里是 SkillApp 唯一的状态层**——飞书多维表格里不存任何运行状态。

```jsonc
{
  "run_id": "20260930-194727-86bc",
  "template_id": "c62d75ba-…",
  "template_name": "image-merge-7417ead8", // 发起时定下；之后不反查
  "skill_hash": "sha256:a19b…",            // 本次使用的 Skill 版本
  "work_hash": "sha256:7c31…",             // Skill + 命令 + 目标 + 生效映射
  "exec_hash": "sha256:…",                 // 解析出的输出 + 以上版本；续跑靠它判定能不能复用
  "trigger": "incremental",                // all | incremental
  "status": "completed",                   // completed | partial | failed | canceled | interrupted
  "succeeded": 1,
  "failed": 0,
  "items": [
    {
      "record_id": "rec…",
      "status": "succeeded",               // succeeded | failed
      "stage": null,                       // validate | exec | upload | writeback
      "ms": 404,
      "error": null,
      "input_hash": "sha256:0fdc20aaa60db75a",
      "resumed_from": null                 // 复用了上一次的产物时，指向那个 run_id
    }
  ]
}
```

约定：

- 所有 hash 都带算法前缀（`sha256:`）。`input_hash` 看输入本身，`work_hash` 看工作版本；两者一致的行才会被 `--incremental` 跳过。
- 判定只看**最近一次**运行，不看「历史上是否曾经成功」——否则把输入改回旧值会被误判为已完成，而表里的输出其实是另一组输入的产物。
- `stage` 区分失败发生在哪一步：`validate` 是输入不合规（重试没意义），`exec` / `upload` / `writeback` 才值得重试。
- 日志**原样落盘**，不做 JSON 包装——它首先是给人看的（界面直接展示这些文本）。
- 产物既回写进表格，也在本机留一份；界面按相对路径读取。
- 本目录**只增不减**，失败行还会被 `--incremental` 反复捞出：现在没有清理策略。

📖 执行语义见 [`docs/run.md`](../docs/run.md)。

**本目录为空 = 从未运行过。**
