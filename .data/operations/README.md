# operations/

**异步操作的状态**：每个操作一个目录，`operation.json` 记录状态、输入、结果与错误。
界面上对应 `Operations` 页与侧边栏的 `Messages` 区。

```text
operations/<operation_id>/operation.json
```

```jsonc
{
  "operation_id": "20261012-190323-0b54",
  "type": "bind-table",  // load-skill | analyze-skill | bind-table | unload-skill
                         // archive-template | unarchive-template | run-template
  "status": "completed", // queued | running | canceling | completed | failed | canceled | interrupted
  "created_at": "…",
  "started_at": "…",
  "finished_at": "…",
  "input": {},
  "result": {},
  "error": null,
  "lock_keys": ["skill:image-merge", "table:base:table"]
}
```

约定：

- `run-template` 在这里只是**索引镜像**（摘要），明细仍只在 `runs/`——Operations 页与 Messages 区靠它统一列出所有长期任务。
- 状态变化会通过全局 SSE（`GET /api/operations/events`）推给界面，不需要轮询。
- 服务启动时会把遗留的 `running` 标成 `interrupted`——不自动续跑。
- 删除这些记录只影响历史展示，不影响 `runs/` 里的运行数据。

📖 见 [`docs/api.md`](../docs/api.md) 与 [`docs/architecture.md`](../docs/architecture.md)。

**本目录为空 = 还没执行过任何异步操作。**
