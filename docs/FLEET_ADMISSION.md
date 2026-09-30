# 节点多机派发协议

Portal 先持久化目标服务器与 UUID admissionKey，再调用节点。结果不明时只重放该服务器、该 token 和同一份 spec；只有明确 `accepted:false` 才能改投其他服务器。

节点强制 SSH 接口：

- `offer {job, allowPreempt:false}`：只读返回 `idle/preempt/busy` 和可分配卡数，不创建工作区、spec、token 或租约。
- `admit {job, admissionKey, allowPreempt:false}`：返回 `accepted:false,state:REJECTED`，或 `accepted:true,nodeJobId,state,assignedIndices`。
- `cancel-admission`：参数与原 admit 完全相同。还没接受则写入持久取消墓碑；已经接受则只取消 receipt 所指向的原任务。

`allowPreempt` 的布尔值也属于 token 身份，不能在重试时改变。取消后，迟到的同 token admit 不会创建训练。已经接受的 receipt 永远不会变成“拒绝”；原生 GPU 租约尚未清理时，节点返回 `UNKNOWN`，Portal 保留额度。

这些操作使用同一个原生 `prepare_submission/validate_submission` 与节点参数生成函数。固定宿主机 `ROOT/jobs` 只用于启动可信沙箱包装程序；训练仍在自己的 `/workspace` 运行。代码/环境版本、数据快照或个人工作区通过已有 `GPU_SYNC_INPUT_PATHS` 声明给原生同步守卫。

原生 CLI 对应 `gpu submit ... --offer-only`、`--admission-token UUID`、`--admission-token UUID --cancel-admission`；选择抢占时追加 `--admission-preempt`。生产路由需同时确认 `fleet-admission-v2` 和 `console-fleet-v1`。

部署需同步更新 GPUQ、节点执行器/采集器/调度参数模块和执行桥；安装器预建 `ROOT/jobs`。本功能不改数据库 schema，receipt 使用既有 settings 表。回退到不支持取消墓碑的版本前，先处理所有结果不明的派发记录；不能直接重新路由它们。本 PR 不自动部署。
