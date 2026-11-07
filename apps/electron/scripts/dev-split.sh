#!/usr/bin/env bash
# 独立构建禁用未验证归属的 Vite 开发服务，避免将其他项目加载到带权限的 preload。
set -euo pipefail
printf '%s\n' '独立版暂不支持分屏热重载；请在本仓库运行 bun run dev。'
exit 1
