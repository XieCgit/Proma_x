import { describe, expect, mock, test } from 'bun:test'
import type { BrowserWindow } from 'electron'

let checks = 0
let listeners = 0
let installations = 0
const statuses: unknown[] = []

mock.module('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates: async () => { checks += 1 },
    on: () => { listeners += 1 },
    quitAndInstall: () => { installations += 1 },
  },
}))
mock.module('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
}))

const updater = await import('./auto-updater')
const window = {
  webContents: { send: (_channel: string, status: unknown) => statuses.push(status) },
} as unknown as BrowserWindow

describe('独立构建更新源隔离', () => {
  test('Given 未配置独立更新源 When 初始化或手动检查 Then 不连接或安装上游更新', async () => {
    updater.initAutoUpdater(window)
    await updater.checkForUpdates()
    expect(checks).toBe(0)
    expect(listeners).toBe(0)
    expect(installations).toBe(0)
    expect(updater.installWhenIdle()).toBe(false)
    expect(updater.getUpdateStatus()).toEqual({
      status: 'error',
      error: '独立版本尚未配置更新源，请从本项目的仓库获取更新。',
    })
    expect(statuses).toHaveLength(1)
  })
})
