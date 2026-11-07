/**
 * Shared configuration for proma
 */

// 保留上游名称常量，避免改变依赖它的既有协议与显示逻辑。
export const APP_NAME = 'Proma'

/** 独立构建不得默认使用上游 Proma 的持久化或临时目录。 */
export const INDEPENDENT_PREVIEW_TEMP_DIR = 'proma-agent-next-preview'
export const INDEPENDENT_INSTALLER_TEMP_DIR = 'proma-agent-next-installers'

export function getIndependentConfigDirName(isDevelopment: boolean): string {
  return isDevelopment ? '.proma-agent-next-dev' : '.proma-agent-next'
}

/** Electron userData 也必须与其他正式版和开发实例隔离。 */
export function getIndependentUserDataDirName(isDevelopment: boolean, instance?: string): string {
  if (!isDevelopment) return 'proma-agent-next'
  const safeInstance = instance?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  return safeInstance ? `proma-agent-next-dev-${safeInstance}` : 'proma-agent-next-dev'
}
