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
- `contracts/session.mjs`、`api/session-handler.mjs`、`client/session-client.mjs`：网页／CLI 同一登录契约和 SDK，Cookie／Bearer 交付不同但业务用例相同。`bootstrap/sqlite-session.mjs` 显式组装；当前会话恢复与 CLI 凭据落盘待接。
- `infrastructure/sqlite/`：独立的会话、权限快照和来源查询。schema 初始化显式进行，查询类不会建表或迁移。
- `bootstrap/sqlite-data-read.mjs`：节点本地 SQLite 集成入口；VPS 必须选择远端来源适配器，不能把远端路径拿到 VPS 上检查。
- `api/data-read-handler.mjs`：认证、报文解析和错误映射；内部诊断留在服务端。
- `client/`：网页和 Node 共用的 SDK／HTTP 实现；`ClientSession` 是凭据和请求生命周期的唯一所有者，切换身份后拒绝旧请求结果。不重复业务规则，不自动回退或重试。

验证：`npm run test:v2` 和 `npm run test:v2:browser`。依赖方向也有测试，禁止新实现重新导入旧 `PortalService` 或演示服务。

本链路返回读取位置的观察，不创建挂载或数据租约。生产身份迁移、远端数据目录、容器挂载以及新网页／CLI 外壳仍待接入，不能据此宣布完整数据读取或整体重构已上线。
