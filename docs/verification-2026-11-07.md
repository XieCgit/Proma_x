# 独立构建验证记录

**日期：**2026-11-07
**上游源码基线：**`86d9dfb511db4c1e3ffded3b6c3e312996f50cbf`
**平台：**macOS Intel x86_64；Bun 1.4.4；Electron 43.2.0

## 已执行

1. 使用独立仓库 `.local/sandbox/` 下的 HOME、临时目录与缓存执行依赖安装；`bun install --frozen-lockfile --offline --ignore-scripts` 成功，未运行依赖包安装脚本。
2. 全仓 `bun run typecheck` 通过，覆盖 shared、core、session-core、CLI、UI、Electron。
3. 针对本次变更及部分上游相关模块，使用 `bun test --isolate` 运行 **21 个测试文件、160 项测试，全部通过**。其中包括配置目录、临时路径、更新器、活动槽启动保护、会话 Token 汇总、提示词增强请求与 IPC、旧配置隔离哨兵等。测试中使用假渠道、假密钥与模拟网络响应，未调用真实模型。
4. `build:main`、`build:agent-runtime`、`build:terminal-runtime`、`build:preload`、`build:renderer`、`build:cli`、`build:resources` 成功。检查编译后的主进程初始化代码，独立 `bootstrap-paths` 在业务模块及单实例锁之前运行。
5. 在隔离 HOME 下运行编译出的 `proma-agent-next --help` 和 `proma-agent-next session list --json`，返回独立 CLI 帮助及空列表。
6. 利用浏览器与模拟 IPC 检查提示词增强对话框及 Token 面板：确认发送前提示、模拟结果展示，以及输入、输出、缓存和总计。模拟页面不是实际 Electron 主窗口，也不验证真实模型请求。
7. OfficeCLI 上游资源按构建脚本固定 SHA-256 下载并校验，生成物被 Git 忽略；EventKit 原生模块已编译，二进制中包含独立 `proma-agent-next://planning/` 标识。
8. GPT 审核 Gemini 3.8 Flash 产出；Gemini 4 独立审查默认隔离、IPC 与异常恢复设计。对审查发现的日志泄露、重复取消绕过并发限制、流式响应预算、上游 EventKit 标识复用等问题作了对应调整并回归。

## 未通过或未覆盖

- 系统 `xcrun swiftc --version` 本身以 `SIGILL` 退出；因此 Swift 原生悬浮组件无法编译，上游完整 `electron:build` 与可分发桌面安装包未通过验证。未修改系统工具链或绕过签名及 Gatekeeper。
- 未启动完整 Electron 桌面应用，未验证新旧应用并行运行、真实系统权限、快捷键实际占用、界面与主进程集成、签名或公证。
- 未配置真实渠道密钥，未调用真实付费模型；提示词增强与普通 API Key 渠道的端到端兼容性仍需验证。远端 HTTP、OAuth 和 Antigravity 渠道不支持本功能。
- 停止/失败后完整保留并续接输出尚未集成。`interrupted-output.ts` 仅为有界缓冲实验模块；具体并发与 Pi artifact 设计见 `docs/plans/2026-11-07-interrupted-output-followup.md`。
- Antigravity 专属集成未实现；当前没有其自定义源码、可验证的完整协议及合法可移植的运行时。
- 测试只覆盖列出的目标文件，不能推断所有上游功能均已验证。开发版仍可使用用户显式授权的文件与系统资源；默认路径隔离不是 OS 安全沙箱。

详细测试日志位于本机忽略目录 `.local/verification-final-tests.log`，构建日志位于 `.local/verification-build-final.log`，不会提交到 Git。
