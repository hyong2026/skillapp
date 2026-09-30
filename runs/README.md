# runs/

运行记录与产物。**内容不进 git**，本文件除外。

每次执行产生一个 `runs/<run_id>/`：

| 路径 | 是什么 |
|---|---|
| `run.json` | **Run**：模板与版本、trigger、状态、统计、逐行摘要 |
| `items.ndjson` | **RunItem**：每行一条（含输入指纹、耗时、错误、产物路径） |
| `downloads/<record_id>/` | 输入快照，可据此复跑 |
| `artifacts/<record_id>/` | 该行的产物 |
| `<record_id>.stdout.log` `.stderr.log` | skill 的原始输出 |

**这里是 SkillApp 唯一的状态层** —— 飞书 Base 里不存任何运行状态。

`--pending` 就是读这里的历史，判断哪些行还没有「输入指纹相同的成功记录」。

**本目录为空 = 从未运行过。**

注意：本目录只增不减，且失败行会被 `--pending` 反复捞出（它就是「没有成功记录」）。
目前没有清理策略。