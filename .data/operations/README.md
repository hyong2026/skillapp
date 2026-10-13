# operations/

非 Run 异步操作的状态。**内容不进 Git**，本文件除外。

每个异步操作产生一个 `.data/operations/<operation_id>/operation.json`：

```jsonc
{
  "operation_id": "20261012-190323-0b54",
  "type": "map-table",              // load-skill | analyze-skill | map-table | unload-skill | run-template
  "status": "completed",            // queued | running | canceling | completed | failed | canceled | interrupted
  "created_at": "…",
  "started_at": "…",
  "finished_at": "…",
  "input": {},
  "result": {},
  "error": null,
  "lock_keys": ["skill:image-merge", "table:base:table"]
}
```

Run 仍保存在 `runs/`；这里放 load-skill、analyze-skill、map-table、unload-skill 四类异步操作，
以及 `run-template` 的索引镜像（只有摘要，明细在 `runs/`）。
