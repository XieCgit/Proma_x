import { describe, expect, test } from 'bun:test'
import { releaseActiveRunOnPreflightFailure } from './active-run-cleanup'

describe('Agent 运行槽启动保护', () => {
  test('Given 启动期间代理解析失败 When 退出运行 Then 释放本代槽位并允许下次启动', async () => {
    const active = new Map([['session', 1]])
    await expect(releaseActiveRunOnPreflightFailure(
      async () => { throw new Error('代理不可用') },
      () => { if (active.get('session') === 1) active.delete('session') },
    )).rejects.toThrow('代理不可用')
    expect(active.has('session')).toBe(false)
    active.set('session', 2)
    expect(active.get('session')).toBe(2)
  })

  test('Given 旧运行失败晚于新运行启动 When 清理旧代 Then 不释放新代槽位', async () => {
    const active = new Map([['session', 1]])
    await expect(releaseActiveRunOnPreflightFailure(
      async () => { active.set('session', 2); throw new Error('旧运行失败') },
      () => { if (active.get('session') === 1) active.delete('session') },
    )).rejects.toThrow('旧运行失败')
    expect(active.get('session')).toBe(2)
  })

  test('Given 启动回调同步抛错 When 准备运行 Then 仍执行清理', async () => {
    let released = false
    await expect(releaseActiveRunOnPreflightFailure(
      () => { throw new Error('启动回调失败') },
      () => { released = true },
    )).rejects.toThrow('启动回调失败')
    expect(released).toBe(true)
  })

  test('Given 启动准备成功 When 进入主循环 Then 保持运行槽直到主循环退出', async () => {
    let released = false
    const value = await releaseActiveRunOnPreflightFailure(
      async () => 'ready',
      () => { released = true },
    )
    expect(value).toBe('ready')
    expect(released).toBe(false)
  })
})
