import { describe, expect, test } from 'bun:test'
import {
  INDEPENDENT_INSTALLER_TEMP_DIR,
  INDEPENDENT_PREVIEW_TEMP_DIR,
  getIndependentConfigDirName,
  getIndependentUserDataDirName,
} from './index'

describe('独立 Agent 应用身份', () => {
  test('Given 正式环境 When 选择配置目录 Then 不使用旧版 Proma 目录', () => {
    expect(getIndependentConfigDirName(false)).toBe('.proma-agent-next')
    expect(getIndependentConfigDirName(false)).not.toBe('.proma')
  })

  test('Given 开发环境 When 选择配置目录 Then 与正式及旧版开发目录隔离', () => {
    expect(getIndependentConfigDirName(true)).toBe('.proma-agent-next-dev')
    expect(getIndependentConfigDirName(true)).not.toBe('.proma-dev')
    expect(getIndependentConfigDirName(true)).not.toBe(getIndependentConfigDirName(false))
  })

  test('Given 开发实例 When 生成 Electron userData 名称 Then 清理路径符号并与正式版隔离', () => {
    expect(getIndependentUserDataDirName(false)).toBe('proma-agent-next')
    expect(getIndependentUserDataDirName(true)).toBe('proma-agent-next-dev')
    expect(getIndependentUserDataDirName(true, '../test_1')).toBe('proma-agent-next-dev-test_1')
    expect(getIndependentUserDataDirName(true, '../test_1')).not.toContain('/')
    expect(getIndependentUserDataDirName(false, 'ignored')).toBe('proma-agent-next')
  })

  test('Given 临时资源 When 选择缓存目录 Then 不共享旧版预览和安装包目录', () => {
    expect(INDEPENDENT_PREVIEW_TEMP_DIR).toBe('proma-agent-next-preview')
    expect(INDEPENDENT_INSTALLER_TEMP_DIR).toBe('proma-agent-next-installers')
  })
})
