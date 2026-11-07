import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'next-electron-paths-'))
const calls: Array<[string, string]> = []
mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => root,
    setName: (value: string) => { calls.push(['name', value]) },
    setPath: (key: string, value: string) => { calls.push([key, value]) },
  },
}))

await import('./bootstrap-paths')

describe('Electron 独立启动身份', () => {
  test('Given 正式应用启动 When 初始化路径 Then 使用独立名称和持久化目录', () => {
    expect(calls).toContainEqual(['name', 'Proma Agent Next'])
    expect(calls).toContainEqual(['userData', join(root, 'proma-agent-next')])
    expect(calls).toContainEqual(['sessionData', join(root, 'proma-agent-next')])
  })

  test('Given 主进程入口 When 检查导入顺序 Then 路径 bootstrap 先于业务模块和单实例锁', () => {
    const entry = readFileSync(resolve(import.meta.dir, 'index.ts'), 'utf8')
    expect(entry.indexOf("import './bootstrap-paths'")).toBeGreaterThanOrEqual(0)
    expect(entry.indexOf("import './bootstrap-paths'")).toBeLessThan(entry.indexOf("from 'electron'"))
    expect(entry.indexOf("import './bootstrap-paths'")).toBeLessThan(entry.indexOf('app.requestSingleInstanceLock()'))
  })
})
