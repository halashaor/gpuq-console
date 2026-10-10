# V2 源码入口

当前可运行链路：

`DataClient → JsonHttpTransport → createDataReadHandler → ResolveDataRead → LocalSourceReader`

`assembleDataRead` 只负责组装。认证、授权和来源目录通过明确的接口注入，不启动服务、不创建数据库、不读取生产全局配置。

- `contracts/data-read.mjs`：唯一的数据读取请求／响应契约，供服务端和两种客户端共用。
- `domain/`：错误代码、数据来源的容器命名规则，无网络或文件系统依赖。
- `application/resolve-data-read.mjs`：访问授权与读取观察的调用顺序，无 SQL、SSH、HTTP 或旧服务依赖。
- `infrastructure/local-source-reader.mjs`：向目录查询接口取可信路径，只读检查真实目录，不准备缓存、不复制、不检查写入额度。
- `api/data-read-handler.mjs`：认证、报文解析和错误映射；内部诊断留在服务端。
- `client/`：网页和 Node 共用的 SDK／HTTP 实现；`ClientSession` 是凭据和请求生命周期的唯一所有者，切换身份后拒绝旧请求结果。不重复业务规则，不自动回退或重试。

验证：`npm run test:v2` 和 `npm run test:v2:browser`。依赖方向也有测试，禁止新实现重新导入旧 `PortalService` 或演示服务。

本链路返回读取位置的观察，不创建挂载或数据租约。生产认证、数据目录适配器、容器挂载以及新网页／CLI 外壳仍待接入，不能据此宣布完整数据读取或整体重构已上线。
