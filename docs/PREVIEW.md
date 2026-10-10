# 真实资源灰度版

普通入口不变。只有管理员加入灰度名单的账号可以进入；灰度操作会影响自己的真实项目和训练，不是模拟演示。

## 网页

先在正常网页登录，再打开同一域名的 `/__preview__/`。页面顶部显示“灰度版 · 真实资源”。点击“返回稳定版”退出；已有任务继续运行。

## CLI

Linux／WSL 上从本站单独安装，不替换原来的 `gpuctl`：

```sh
curl -fsS https://你的平台域名/__preview__/install.sh | sh
~/.local/bin/gpuctl-preview preview on
~/.local/bin/gpuctl-preview jobs
~/.local/bin/gpuctl-preview preview off
```

沿用本人已有登录和项目选择。没有登录时先运行 `gpuctl-preview login`；加入灰度必须由服务器确认授权，失败不会改变本地选择。`preview status` 查看该客户端选择。`off` 不依赖灰度服务在线，不取消、重提或迁移任务。Windows 原生自动安装尚未提供；可先用网页或 WSL。

第一阶段灰测网页与 CLI，后端任务状态和资源分配仍共用现役控制端。不能据此认定新的后端或节点运行器已经上线。普通稳定版 CLI 保持原版本和行为。
