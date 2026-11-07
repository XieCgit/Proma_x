# Proma Agent Next

Proma Agent Next 是基于 [Proma 开源社区版](https://github.com/proma-ai/Proma) 的独立实验性桌面构建，不是 Proma 官方商业版。上游基线为 `86d9dfb511db4c1e3ffded3b6c3e312996f50cbf`。本仓库保留上游 `LICENSE`、版权声明及 AGPL-3.0 许可；分发时应遵守相应的源码提供义务。

## 当前状态

这是正在开发的源代码仓库，不是经过完整验收的正式发行版。当前变更包括：

- 独立的应用名称、打包标识、默认配置及临时资源目录；默认不读取或覆盖上游 Proma 的配置。
- 开发主窗口和辅助窗口加载本地构建页面，不连接可能被其他程序占用的默认开发端口；开发热重载暂时关闭。
- 未配置独立发布源前，自动更新和上游版本查询被禁用；上游发布工作流保存在 `.github/workflows/release.yml.disabled`，不会被 GitHub Actions 自动执行。
- 独立 CLI `proma-agent-next`，用于渐进读取本应用的会话记录。
- Agent 界面增加本会话已保存 Token 用量汇总，仅统计已有 `result.usage`，缺失或异常记录会标记为不完整；这不是计费账单或实时额度。
- 加入代理预检失败时释放 Agent 运行槽的防护。停止或断线后保留并恢复全部回复仍需进一步集成测试，不能视为已完成。
- 默认不注册系统全局快捷键，也不启用原生悬浮层；如需使用，可在设置中显式启用，以免与现有应用冲突。EventKit 自有同步标识也使用独立命名空间。

提示词增强已接入 Agent 输入工具栏：先预览文本，再由用户明确点击发送；结果只供复制，不自动覆盖原草稿。该功能仅支持适配器已覆盖的普通 API Key 渠道，远端地址必须使用 HTTPS（本机回环地址可用 HTTP），OAuth 订阅及 Antigravity 暂不支持；已使用模拟请求测试，尚未完成真实模型与桌面界面端到端验证。Antigravity 专属集成缺少对应授权源码与可验证的协议/运行时，尚未实现。社区版上游的其他功能也尚未逐项完成本机验收。

## 默认数据位置与边界

| 数据 | 默认位置 |
| --- | --- |
| 正式版数据 | `~/.proma-agent-next/` |
| 开发版数据 | `~/.proma-agent-next-dev/` |
| Electron 浏览器资料 | 独立的 `Proma Agent Next` userData 目录，开发模式另有独立名称 |
| 预览临时文件 | 系统临时目录中的 `proma-agent-next-preview` |
| 安装器临时文件 | 系统临时目录中的 `proma-agent-next-installers` |

这些是**默认路径隔离，不是操作系统沙箱**。Agent 仍可能依照用户授权访问其他目录；显式选择或挂载现有项目也会访问所选位置。正式投入使用前，应在独立 macOS 用户账户或虚拟机中验证，避免与现有应用共享生产数据。迁移、目录覆盖、第三方账户和模型凭据需由用户明确确认；切勿把旧版 `~/.proma` 当作本构建的数据目录。

## 仓库结构

沿用上游 Bun monorepo：

- `apps/electron/`：Electron 主进程、preload、React 界面、默认 Skills 和打包配置。
- `apps/cli/`：`proma-agent-next` 会话读取 CLI。
- `packages/shared/`：共享类型和配置。
- `packages/session-core/`：会话读取、解析和 Token 汇总。
- `packages/core/`、`packages/ui/`：上游的供应商适配层和 UI 基础。
- `docs/plans/2026-11-07-independent-agent.md`：本次建设计划。

本机临时工具和测试数据位于 `.local/`，被 Git 忽略，不属于源码交付。

## 构建和验证

需要兼容项目锁文件的 Bun、Node.js 和相应平台的编译工具。不要将本仓库的安装或构建命令指向现有 Proma 的程序目录或生产数据。

```bash
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run electron:build
```

桌面源码与界面单独构建：

```bash
bun run --cwd apps/electron build:main
bun run --cwd apps/electron build:agent-runtime
bun run --cwd apps/electron build:terminal-runtime
bun run --cwd apps/electron build:preload
bun run --cwd apps/electron build:renderer
bun run --cwd apps/electron build:cli
```

当前测试机为 macOS Intel。该机器系统自带 `swiftc --version` 以 `SIGILL` 退出，因而原生悬浮组件编译及完整桌面打包尚未通过；这不代表上述源码编译即是完整 App 验收。`bun run --cwd apps/electron dev:core` 是不编译原生悬浮组件的开发入口，**当前尚未实机验收**；运行前应使用独立系统账户或虚拟机并检查依赖。不要通过替换系统工具链、覆盖安装或禁用 Gatekeeper 来规避该问题。应用签名和公证需要使用独立项目的合法身份另行配置。

受影响组件的验证应使用独立 HOME、TMPDIR 和缓存，且优先单文件或 `bun test --isolate`，避免上游测试中的全局 mock 相互污染。验证结束后，明确区分单元测试、构建、真实 App 交互、模型请求、签名公证各自的覆盖范围。

## 未来连接自己的 GitHub 仓库

目前只有只读用途的 `upstream` 指向 Proma 官方源码，且其 push URL 被设置为 `DISABLED`。没有配置用户自己的 `origin`，也没有推送。由用户先在 GitHub 创建空仓库，再在明确确认目标后配置：

```bash
git remote add origin <你的 GitHub 仓库地址>
git remote -v
# 核对无误且用户授权后：
git push -u origin main
```

首次推送前应检查 Git 状态、提交内容和密钥；独立发布工作流、签名及更新源均需单独设计并审核，不要直接恢复上游的自动发布配置。
