import { describe, expect, mock, test } from 'bun:test'

let overrides: Record<string, { mac?: string | null; win?: string | null }> = {}
const register = mock((_key: string, _handler: () => void) => true)
mock.module('electron', () => ({
  app: { isReady: () => true },
  globalShortcut: { register, unregister: () => {}, unregisterAll: () => {} },
}))
mock.module('./settings-service', () => ({
  getSettings: () => ({ shortcutOverrides: overrides, voiceDictation: { enabled: false } }),
}))
const shortcuts = await import('./global-shortcut-service')

describe('独立版全局快捷键', () => {
  test('默认不注册，避免抢占其他应用的全局组合；用户显式设置后才注册', () => {
    overrides = {}
    register.mockClear()
    expect(shortcuts.registerGlobalShortcut('quick-task', () => {})).toBe(false)
    expect(register).not.toHaveBeenCalled()
    overrides = { 'quick-task': { mac: 'Alt+Shift+9', win: 'Alt+Shift+9' } }
    expect(shortcuts.reregisterAllGlobalShortcuts()['quick-task']).toBe(true)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toBe('Alt+Shift+9')
    shortcuts.unregisterAllGlobalShortcuts()
  })
})
