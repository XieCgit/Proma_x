import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfigDir } from './paths'

const originalPromaDev = process.env.PROMA_DEV

afterEach(() => {
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
})

describe('独立 Agent CLI 配置路径', () => {
  test('Given 默认正式环境 When 解析配置路径 Then 不指向旧版数据', () => {
    delete process.env.PROMA_DEV
    expect(resolveConfigDir()).toBe(join(homedir(), '.proma-agent-next'))
    expect(resolveConfigDir()).not.toBe(join(homedir(), '.proma'))
  })

  test('Given 开发模式 When 解析配置路径 Then 使用独立开发目录', () => {
    expect(resolveConfigDir({ dev: true })).toBe(join(homedir(), '.proma-agent-next-dev'))
    process.env.PROMA_DEV = '1'
    expect(resolveConfigDir()).toBe(join(homedir(), '.proma-agent-next-dev'))
  })

  test('Given 显式配置目录 When 解析配置路径 Then 保留用户指定的路径', () => {
    expect(resolveConfigDir({ configDir: '/explicit/isolated', dev: true })).toBe('/explicit/isolated')
  })
})
