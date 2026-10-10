# V2 源码入口

当前可运行链路：

`DataClient → JsonHttpTransport → createDataReadHandler → ResolveDataRead → LocalSourceReader`

`assembleDataRead` 只负责组装。认证、授权和来源读取适配器通过明确的接口注入，不启动服务、不创建数据库、不读取生产全局配置。

- `contracts/data-read.mjs`：唯一的数据读取请求／响应契约，供服务端和两种客户端共用。
- `domain/`：错误代码、数据来源的容器命名规则，无网络或文件系统依赖。
- `application/resolve-data-read.mjs`：访问授权与读取观察的调用顺序，无 SQL、SSH、HTTP 或旧服务依赖。
- `infrastructure/local-source-reader.mjs`：固定本节点身份后向目录查询接口取可信路径，只读检查真实目录，不准备缓存、不复制、不检查写入额度。
- `application/authenticate-session.mjs` 和 `data-read-access.mjs`：取得会话／授权事实，调用领域规则；不直接解析 Cookie 或 SQL。
- `application/login.mjs` 和 `session-lifecycle.mjs`：登录签发、续期和注销；密码、令牌和 SQLite 写入分别由专用适配器实现。并发限制要求权威进程共用一个 `Login` 实例。
- `contracts/session.mjs`、`api/session-handler.mjs`、`client/session-client.mjs`：网页／CLI 同一登录契约和 SDK，Cookie／Bearer 交付不同但业务用例相同。恢复时通过 current 接口查询实际身份，确认前不开放业务请求；该查询不暗中续期。`bootstrap/sqlite-session.mjs` 显式组装。
- `infrastructure/open-client-credentials.mjs`：显式创建私有的客户端凭据库，原始令牌按 origin 保存；条件删除防止旧进程注销清掉新登录。不保存密码／角色，不连接服务端数据库。文件权限适配器目前只验证 Linux/POSIX。
- `bootstrap/cli.mjs`：V2 独立命令外壳，调用同一 SDK；`node scripts/v2-client.mjs --help` 查看 login/current/read/logout 用法。必须指定候选 API 和凭据文件，不能据此认为线上已提供 V2 接口；已安装 gpuctl 不受影响。
- `domain/account-policy.mjs` 与账号用例：管理员创建、查询、改角色和启停；事务内核对会话、目标修订和最后管理员规则。`create-account.mjs` 与 `reset-password.mjs` 在密码计算前授权、计算后事务重验，账号／凭据／失效修订原子提交。调用方保留新账号 UUID，创建丢回执后按原 ID 查询，不换号重试。`bootstrap/sqlite-account.mjs` 组装同一 HTTP／SDK 链路。
- `application/list-accounts.mjs`：管理员分页查看用户名、姓名和当前角色／版本。网页／CLI 调用 `AccountClient.list`；独立 CLI 支持 `accounts --limit N --after ID`。分页不冻结跨请求快照，每页重新核对权限。
- `domain/compute-policy.mjs`、`application/compute-policy.mjs`：机器访问与单机／跨机额度配置；`ComputePolicyClient` 共用 HTTP 契约。仓储原子替换现有机器授权行，策略版本防止覆盖并发修改；未知容量／旧上限不猜测。`compute-policy-schema.mjs` 显式建表／扩列，尚未用于生产迁移，调度准入执行额度仍待接。
- `application/data-access.mjs`：管理员查询／替换私有来源的读者名单；`DataAccessClient` 使用同一 API。读者和 ACL 修订原子写入，不修改来源绑定、可见性、所有权或机器授权；共享来源不使用此接口假装取消共享。来源注册与管理页面仍待接。
- `infrastructure/sqlite/`：独立的会话、权限快照和来源查询。schema 初始化显式进行，查询类不会建表或迁移。
- `bootstrap/sqlite-data-read.mjs`：节点本地 SQLite 集成入口；VPS 必须选择远端来源适配器，不能把远端路径拿到 VPS 上检查。
- `api/data-read-handler.mjs`：认证、报文解析和错误映射；内部诊断留在服务端。
- `client/`：网页和 Node 共用的 SDK／HTTP 实现；`ClientSession` 是凭据和请求生命周期的唯一所有者，切换身份后拒绝旧请求结果。不重复业务规则，不自动回退或重试。

验证：`npm run test:v2` 和 `npm run test:v2:browser`。依赖方向也有测试，禁止新实现重新导入旧 `PortalService` 或演示服务。

本链路返回读取位置的观察，不创建挂载或数据租约。生产身份迁移、远端数据目录、容器挂载以及新网页／CLI 外壳仍待接入，不能据此宣布完整数据读取或整体重构已上线。
