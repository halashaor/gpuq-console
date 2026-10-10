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
- `application/data-access.mjs`：管理员查询／替换私有来源的读者名单；`DataAccessClient` 使用同一 API。读者和 ACL 修订原子写入，不修改来源绑定、可见性、所有权或机器授权；共享来源不使用此接口假装取消共享。可见性修改与管理页面仍待接。
- `application/register-directory.mjs`：将操作者预配置的已有目录登记为可选择来源，不复制或探测全目录；权限与绑定在事务内确认，重复相同登记共用资源 ID，冲突不覆盖。`ConfiguredDirectories` 只接受可信配置，API／SDK 只接收机器和来源名。独立 CLI 的 `register-directory` 已接通；生产配置导入尚未完成。
- `infrastructure/http-source-reader.mjs` 与 `api/source-inspection-handler.mjs`：固定节点只读观察通道，独立服务凭据，不接受宿主路径、重定向或自动换机。`assembleSqliteDataRead` 注入该 reader 后在远端 I/O 前后核对用户权限。当前以本地真实 HTTP 节点验证，生产节点与托管版本 READY 证明尚未接入。
- `infrastructure/legacy-cache-reader.py`：窄兼容适配器复用现有发布元数据校验，通过 DatasetCache 的 `initialize=False` 只打开已有布局与锁；不调用工作区、配额、复制或准备。类型由配置固定，已通过本地子进程接入节点观察；旧授权迁移尚未完成，发布目录迁移完成后才退役此适配器。
- `bootstrap/node-source-reader.mjs`：组合原目录与 `ManagedSourceReader`；后者调用 Python 只读适配器，配置根目录不来自请求。内部协议只接收协调器确认的账号 ID，旧元数据 ACL 暂仍校验该账号。ACL 迁移和仓库 authority 根绑定未完成，不能据此替换生产托管路径。
- `application/register-managed-source.mjs`：管理员登记显式配置的固定版本，先以配置所有者检查节点，再原子记录资源与机器／类型位置，不存 READY 或伪造宿主路径。`ManagedRegistrationClient` 已接同一 API；旧 ACL 迁移尚未完成，登记不等于新的共享许可已同步旧发布目录。
- 节点可通过 `coordinatorVersions` 显式将某机器／类型／数据集／版本的授权交给 V2；默认仍保留旧 ACL。请求不能选择此模式，委托不跳过发布完整性检查或开放写操作。原有权限导入与正式入口切换尚待实现，不能直接全库启用。
- `ManagedSourceReader.exportAccess` 与 `domain/data-access-import.mjs`：导出旧 ACL 的绑定快照，按显式账号映射核对全部副本并提出读者导入方案；冲突／缺失／现有撤权不自动处理。
- `application/import-data-access.mjs` 和 `sqlite/data-access-imports.mjs`：提交前重新观察，事务内重建／比对方案，读者与回执原子写入；原请求恢复不重放历史写入。只是 V2 准备状态导入，不修改旧 ACL 或激活节点，正式切换尚待接。
- `DataAccessImportClient` 与 `bootstrap/sqlite-data-access-import.mjs`：同一管理接口供网页／CLI 核对、确认和查询。独立 CLI 支持 `access-import-plan`、`access-import`、`access-import-status`（参数见 `--help`）；null 回执仅代表尚未观察到，保留原 UUID 查询，不换号重提。
- `HttpSourceReader.exportAccess`：固定内部节点路由取得旧 ACL 快照，共用有界读取与独立协调器凭据，保留旧所有者检查。导入 API／浏览器／CLI 已通过隔离远端 HTTP 场景，真实服务器部署和正式切换仍待完成。
- `infrastructure/gpuq-policy.mjs`／`.py`：调用现役 GPUQ 纯策略计算排序、合法弹性 batch、扩容目标和抢占候选，不创建任务或执行动作。部署需保留 `gpuq/gpuq/` 模块目录；资源观察、配额、租约和执行适配尚待接入，计划不等于已经分配 GPU。
- `domain/training-request.mjs` 与 `sqlite/training-requests.mjs`：内部准备载荷的规范化身份和持久日志，保存真实提交者及任务名；回执不含执行参数，重复请求不改写旧记录。RECORDED 不代表 GPUQ 已接受；公开提交接口与项目／资源准入未完成，不能让客户端直接提交 preparedSpec。
- `contracts/training-submission.mjs`：网页／CLI 共用训练输入结构，明确项目 release、容器命令、机器候选、资源与调度选项、逻辑数据来源。不接收宿主路径或执行身份；结构解析不代表项目存在、授权有效或 GPUQ 组合准入通过。
- `application/validate-training-resources.mjs`：将 V2 意图与可信节点池送到 GPUQ 原生纯资源校验。原 GPUQ 完整提交复用同一资源／环境函数，继续独立验证真实 cwd、可执行文件和 RPC 大小；该校验不占卡，也不代替项目、权限、配额或运行库检查。
- `domain/training-candidates.mjs` 与 `sqlite/training-catalog.mjs`：检查项目归属、归档、release 登记和机器授权，输出目录级候选及配置额度上界，不猜测空闲卡或节点文件就绪。正式项目登记、物理实例观察和实际用量检查尚待接入。
- `infrastructure/legacy-project-reader.py`：以无初始化方式读取已有项目 UUID、实例代次和固定 release 元数据；不创建生命周期目录／锁或验证运行环境，runtimeVerified 明确为 false。原生观察已测试，节点协议与项目登记事务尚待接入。
- `application/register-project-release.mjs` 与 `sqlite/project-registrations.mjs`：将账号／机器绑定的观察原子登记到项目目录，UUID 与 generation 防止静默换实例；重复登记不会产生第二个绑定。已通过隔离 HTTP 节点连接原生 reader，仍不代表可启动。
- `ExistingProjectReader` 与 `contracts/project-inspection.mjs`：inspect 读取项目元数据，verifyRuntime 检查已有环境引用；缺失基础环境不妨碍前者，但后者失败且不自动恢复。节点配置独立于请求，二者复用同一认证／HTTP／原生进程通道，不返回宿主路径。runtimeIdentityVerified 不代表训练准入或执行成功。`jsonProcess` 提供有界、无 shell、独立进程组监督的原生 JSON 通信。
- `HttpProjectReader`／`assembleProjectInspection`：项目远端观察复用数据来源的 `NodeJsonTransport` 和节点认证，绑定账号／机器／版本。只完成隔离 HTTP 验证，实际节点部署与运行环境检查仍待接。
- `ProjectClient`／`assembleSqliteProjectRegistration`：网页和 CLI 共用项目登记与存量查询。CLI `register-project`、`project-registration` 参数见 `--help`，重试保留同一逻辑 ID 和引用；查询不联系节点、不提供新的运行证明，亦不启动训练。
- `ObserveTrainingCandidates`：将目录和已登记实例与远端观察逐一匹配，节点局部异常不阻断其他候选；权限／上下文变化使整次观察失效。仍不验证运行环境、空闲卡或占用额度，不创建租约。

托管子进程测试需要真实 Python 3.12，可通过 `V2_PYTHON` 指定解释器；V2 测试还包含真实 Chromium 登记场景。运行目录需保留 `src/infrastructure/legacy-cache-reader.py` 与配套 `deploy/dataset-cache.py` 及其元数据依赖的相对布局；发布打包尚待完成。
- `infrastructure/sqlite/`：独立的会话、权限快照和来源查询。schema 初始化显式进行，查询类不会建表或迁移。
- `bootstrap/sqlite-data-read.mjs`：节点本地 SQLite 集成入口；VPS 必须选择远端来源适配器，不能把远端路径拿到 VPS 上检查。
- `api/data-read-handler.mjs`：认证、报文解析和错误映射；内部诊断留在服务端。
- `client/`：网页和 Node 共用的 SDK／HTTP 实现；`ClientSession` 是凭据和请求生命周期的唯一所有者，切换身份后拒绝旧请求结果。不重复业务规则，不自动回退或重试。

验证：`npm run test:v2` 和 `npm run test:v2:browser`。依赖方向也有测试，禁止新实现重新导入旧 `PortalService` 或演示服务。

本链路返回读取位置的观察，不创建挂载或数据租约。生产身份迁移、远端数据目录、容器挂载以及新网页／CLI 外壳仍待接入，不能据此宣布完整数据读取或整体重构已上线。
