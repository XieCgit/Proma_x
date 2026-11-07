import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROMPT_ENHANCEMENT_IPC_CHANNELS,
  registerPromptEnhancementIpc,
  type PromptEnhancementBrowserWindowLike,
  type PromptEnhancementInvokeEventLike,
  type PromptEnhancementIpcMainLike,
  type PromptEnhancementRuntimeLike,
  type PromptEnhancementWebContentsLike,
} from './prompt-enhancement-ipc'
import type {
  PromptEnhancementInput,
  PromptEnhancementResult,
} from './prompt-enhancement-service'

// ============================================================================
// 测试辅助工厂：完全隔离的 Fake 对象，不依赖真实 Electron 运行时或外部资源
// ============================================================================

interface FakeSenderOptions {
  id?: number
}

function createFakeSender(options?: FakeSenderOptions) {
  const id = options?.id ?? 100
  const mainFrame = { id: 'frame-main', url: 'file:///test/index.html' }
  const navigationListeners: Array<(event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void> = []
  const destroyedListeners: Array<() => void> = []
  const goneListeners: Array<() => void> = []

  const sender: PromptEnhancementWebContentsLike & {
    navigationListeners: typeof navigationListeners
    destroyedListeners: typeof destroyedListeners
    emitNavigation: (url: string, isInPlace: boolean, isMainFrame: boolean) => void
    emitDestroyed: () => void
    emitGone: () => void
  } = {
    id,
    mainFrame,
    navigationListeners,
    destroyedListeners,
    on(event: string, listener: (...args: any[]) => void) {
      if (event === 'did-start-navigation') navigationListeners.push(listener)
      if (event === 'render-process-gone') goneListeners.push(listener)
      return this
    },
    once(event: 'destroyed', listener: () => void) {
      if (event === 'destroyed') {
        destroyedListeners.push(listener)
      }
      return this
    },
    emitNavigation(url: string, isInPlace: boolean, isMainFrame: boolean) {
      for (const listener of navigationListeners) {
        listener({}, url, isInPlace, isMainFrame)
      }
    },
    emitGone() { for (const listener of goneListeners) listener() },
    emitDestroyed() {
      const listeners = [...destroyedListeners]
      destroyedListeners.length = 0
      for (const listener of listeners) {
        listener()
      }
    },
  }

  return sender
}

function createFakeMainWindow(
  webContents: PromptEnhancementWebContentsLike,
  isDestroyed = false
): PromptEnhancementBrowserWindowLike & { setDestroyed: (val: boolean) => void } {
  let destroyed = isDestroyed
  return {
    webContents,
    isDestroyed() {
      return destroyed
    },
    setDestroyed(val: boolean) {
      destroyed = val
    },
  }
}

function createFakeIpcMain(): PromptEnhancementIpcMainLike & {
  handlers: Map<string, (event: PromptEnhancementInvokeEventLike, ...args: any[]) => Promise<any> | any>
  invoke: (channel: string, event: PromptEnhancementInvokeEventLike, ...args: any[]) => Promise<any>
} {
  const handlers = new Map<string, (event: PromptEnhancementInvokeEventLike, ...args: any[]) => Promise<any> | any>()

  return {
    handlers,
    handle(channel: string, listener: (event: PromptEnhancementInvokeEventLike, ...args: any[]) => Promise<any> | any) {
      handlers.set(channel, listener)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    },
    async invoke(channel: string, event: PromptEnhancementInvokeEventLike, ...args: any[]) {
      const handler = handlers.get(channel)
      if (!handler) {
        throw new Error(`未注册的 IPC 通道: ${channel}`)
      }
      return handler(event, ...args)
    },
  }
}

function createFakeRuntime(): PromptEnhancementRuntimeLike & {
  calls: {
    enhance: Array<{ ownerId: number; input: PromptEnhancementInput }>
    cancel: Array<{ ownerId: number; requestId: string }>
    cancelOwner: number[]
    getInFlightCount: Array<number | undefined>
  }
  setActiveCount: (count: number) => void
  setEnhanceResult: (result: PromptEnhancementResult) => void
  setCancelResult: (result: boolean) => void
} {
  let activeCount = 0
  let enhanceResult: PromptEnhancementResult = {
    success: true,
    text: '已增强的优质提示词',
  }
  let cancelResult = true

  const calls = {
    enhance: [] as Array<{ ownerId: number; input: PromptEnhancementInput }>,
    cancel: [] as Array<{ ownerId: number; requestId: string }>,
    cancelOwner: [] as number[],
    getInFlightCount: [] as Array<number | undefined>,
  }

  return {
    calls,
    setActiveCount(count: number) {
      activeCount = count
    },
    setEnhanceResult(result: PromptEnhancementResult) {
      enhanceResult = result
    },
    setCancelResult(result: boolean) {
      cancelResult = result
    },
    getInFlightCount(ownerId?: number) {
      calls.getInFlightCount.push(ownerId)
      return activeCount
    },
    async enhance(ownerId: number, input: PromptEnhancementInput) {
      calls.enhance.push({ ownerId, input })
      return enhanceResult
    },
    cancel(ownerId: number, requestId: string) {
      calls.cancel.push({ ownerId, requestId })
      return cancelResult
    },
    cancelOwner(ownerId: number) {
      calls.cancelOwner.push(ownerId)
      return 1
    },
  }
}

// ============================================================================
// 测试主体套件
// ============================================================================

describe('prompt-enhancement-ipc (提示词增强 IPC 模块)', () => {
  let originalHome: string | undefined
  let originalTmpdir: string | undefined
  let sandboxDir: string | null = null

  beforeEach(() => {
    originalHome = process.env.HOME
    originalTmpdir = process.env.TMPDIR
    sandboxDir = mkdtempSync(join(tmpdir(), 'proma-ipc-sandbox-'))
    process.env.HOME = sandboxDir
    process.env.TMPDIR = sandboxDir
  })

  afterEach(() => {
    if (sandboxDir) {
      try {
        rmSync(sandboxDir, { recursive: true, force: true })
      } catch {
        // 忽略沙箱清理异常
      }
    }
    process.env.HOME = originalHome
    process.env.TMPDIR = originalTmpdir
  })

  describe('1. 处理器注册与销毁 (Registration & Dispose)', () => {
    test('应正确在 ipcMain 上注册 ENHANCE 与 CANCEL 两个通道', () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender()
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      expect(ipcMain.handlers.has(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE)).toBe(true)
      expect(ipcMain.handlers.has(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL)).toBe(true)
    })

    test('调用 dispose 应移除已注册的处理器并清理状态', () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender()
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      const registration = registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      registration.dispose()

      expect(ipcMain.handlers.has(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE)).toBe(false)
      expect(ipcMain.handlers.has(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL)).toBe(false)
    })
  })

  describe('2. 发送方安全性校验 (assertPromptSender)', () => {
    test('主窗口不存在 (null 或 undefined) 时，enhance 和 cancel 均拒绝并抛出明确错误', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender()
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => null,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      await expect(
        ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
          requestId: 'req-1',
          channelId: 'chan-1',
          modelId: 'model-1',
          draft: '测试提示词',
        })
      ).rejects.toThrow('仅主窗口可以优化提示词。')

      await expect(
        ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL, event, 'req-1')
      ).rejects.toThrow('仅主窗口可以优化提示词。')

      expect(runtime.calls.enhance.length).toBe(0)
      expect(runtime.calls.cancel.length).toBe(0)
    })

    test('主窗口已销毁时，拒绝调用并抛出错误', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender()
      const mainWindow = createFakeMainWindow(sender, true) // 已销毁
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      await expect(
        ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
          requestId: 'req-1',
          channelId: 'chan-1',
          modelId: 'model-1',
          draft: '测试提示词',
        })
      ).rejects.toThrow('仅主窗口可以优化提示词。')
    })

    test('来自其他 WebContents (非主窗口 sender) 时，拒绝调用', async () => {
      const ipcMain = createFakeIpcMain()
      const mainSender = createFakeSender({ id: 1 })
      const otherSender = createFakeSender({ id: 2 })
      const mainWindow = createFakeMainWindow(mainSender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender: otherSender,
        senderFrame: otherSender.mainFrame,
      }

      await expect(
        ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
          requestId: 'req-1',
          channelId: 'chan-1',
          modelId: 'model-1',
          draft: '测试提示词',
        })
      ).rejects.toThrow('仅主窗口可以优化提示词。')
    })

    test('主窗口被替换场景：旧主窗口 sender 立即失效被拒绝，新主窗口 sender 允许调用', async () => {
      const ipcMain = createFakeIpcMain()
      const sender1 = createFakeSender({ id: 101 })
      const sender2 = createFakeSender({ id: 102 })
      const window1 = createFakeMainWindow(sender1)
      const window2 = createFakeMainWindow(sender2)
      let currentWindow = window1
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => currentWindow,
        runtime,
      })

      // 阶段 1：window1 是主窗口，sender1 成功
      const event1: PromptEnhancementInvokeEventLike = {
        sender: sender1,
        senderFrame: sender1.mainFrame,
      }
      const res1 = await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event1, {
        requestId: 'req-1',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '提示词1',
      })
      expect(res1.success).toBe(true)

      // 阶段 2：主窗口替换为 window2
      currentWindow = window2

      // window1 (旧窗口) 再次调用应被拒绝
      await expect(
        ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event1, {
          requestId: 'req-2',
          channelId: 'chan-1',
          modelId: 'model-1',
          draft: '提示词2',
        })
      ).rejects.toThrow('仅主窗口可以优化提示词。')

      // window2 (新窗口) 调用应成功
      const event2: PromptEnhancementInvokeEventLike = {
        sender: sender2,
        senderFrame: sender2.mainFrame,
      }
      const res2 = await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event2, {
        requestId: 'req-3',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '提示词3',
      })
      expect(res2.success).toBe(true)
    })

    test('子 Frame (iframe/子 frame 发起) 一律拒绝', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender()
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const subFrame = { id: 'frame-sub-iframe' }
      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: subFrame, // 不是 mainFrame
      }

      await expect(
        ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
          requestId: 'req-sub',
          channelId: 'chan-1',
          modelId: 'model-1',
          draft: '子frame提示词',
        })
      ).rejects.toThrow('仅主窗口可以优化提示词。')

      await expect(
        ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL, event, 'req-sub')
      ).rejects.toThrow('仅主窗口可以优化提示词。')
    })
  })

  describe('3. 事件绑定与无重复注册保证 (Event Binding & Deduplication)', () => {
    test('首次请求为 owner 绑定 did-start-navigation 与 destroyed，同一 owner 多次请求不重复注册 listener', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 200 })
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      // 第一次请求
      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
        requestId: 'req-1',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '第一条提示词',
      })

      expect(sender.navigationListeners.length).toBe(1)
      expect(sender.destroyedListeners.length).toBe(1)

      // 第二次请求（同一 owner）
      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
        requestId: 'req-2',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '第二条提示词',
      })

      // 第三次请求（cancel 通道，同一 owner）
      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL, event, 'req-2')

      // 验证 listener 绝无重复注册
      expect(sender.navigationListeners.length).toBe(1)
      expect(sender.destroyedListeners.length).toBe(1)
    })
  })

  describe('4. 导航与生命周期取消处理 (Lifecycle & Navigation Handling)', () => {
    test('渲染进程崩溃时取消请求，非文件来源不允许发起', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 399 })
      const runtime = createFakeRuntime()
      registerPromptEnhancementIpc({ ipcMain, getMainWindow: () => createFakeMainWindow(sender), runtime })
      const event = { sender, senderFrame: sender.mainFrame }
      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL, event, 'x')
      sender.emitGone()
      expect(runtime.calls.cancelOwner).toEqual([399])
      ;(sender.mainFrame as { url: string }).url = 'https://untrusted.example/'
      await expect(ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL, event, 'x')).rejects.toThrow()
    })

    test('主 frame 跨文档导航 (isMainFrame=true, isInPlace=false) 取消该 owner 的请求', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 300 })
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
        requestId: 'req-1',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '测试',
      })

      // 触发主 frame 跨文档导航
      sender.emitNavigation('https://proma.local/new-doc', false, true)

      expect(runtime.calls.cancelOwner).toEqual([300])
    })

    test('同文档导航 (isInPlace=true) 和子 frame 导航 (!isMainFrame) 均不取消 owner', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 301 })
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
        requestId: 'req-1',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '测试',
      })

      // 1. 同文档 hash 路由或 pushState 导航
      sender.emitNavigation('https://proma.local/#section', true, true)
      expect(runtime.calls.cancelOwner.length).toBe(0)

      // 2. 子 frame 跨文档导航
      sender.emitNavigation('https://proma.local/iframe', false, false)
      expect(runtime.calls.cancelOwner.length).toBe(0)

      // 3. 子 frame 同文档导航
      sender.emitNavigation('https://proma.local/iframe#foo', true, false)
      expect(runtime.calls.cancelOwner.length).toBe(0)
    })

    test('WebContents destroyed 触发取消并清理 registeredPromptOwners 状态', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 302 })
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
        requestId: 'req-1',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '测试',
      })

      expect(sender.destroyedListeners.length).toBe(1)

      // 触发 destroyed
      sender.emitDestroyed()

      expect(runtime.calls.cancelOwner).toEqual([302])

      // destroyed 后再次发起请求时（如极端场景 ID 复用），能重新触发绑定
      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
        requestId: 'req-2',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '新测试',
      })

      // 验证重新绑定了一次
      expect(sender.navigationListeners.length).toBe(2)
      expect(sender.destroyedListeners.length).toBe(1)
    })
  })

  describe('5. 并发限制与 BUSY 状态 (Concurrency & BUSY Code)', () => {
    test('活跃请求数 < 2 时，正常进入 runtime.enhance 并返回其结果', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 400 })
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      runtime.setActiveCount(1) // 活跃请求数为 1
      runtime.setEnhanceResult({ success: true, text: '优化的结果' })

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      const result = await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
        requestId: 'req-1',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '优化前的草稿',
      })

      expect(result).toEqual({ success: true, text: '优化的结果' })
      expect(runtime.calls.enhance.length).toBe(1)
      expect(runtime.calls.enhance[0]?.ownerId).toBe(400)
    })

    test('每 owner 活跃请求数 >= 2 时拒绝，返回 { success: false, code: "BUSY" } 且不调用 runtime.enhance', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 401 })
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      runtime.setActiveCount(2) // 已达上限 2

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      const result = await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, {
        requestId: 'req-overflow',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: '超限草稿',
      })

      expect(result).toEqual({ success: false, code: 'BUSY' })
      expect(runtime.calls.enhance.length).toBe(0)
    })
  })

  describe('6. 请求取消隔离性 (Cancel Isolation by Owner)', () => {
    test('cancel 严格按 event.sender.id (ownerId) 操作，不串台其他 owner', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 500 })
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      const res = await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL, event, 'req-cancel-1')

      expect(res).toBe(true)
      expect(runtime.calls.cancel).toEqual([
        {
          ownerId: 500,
          requestId: 'req-cancel-1',
        },
      ])
    })
  })

  describe('7. 接口与数据隔离安全 (Security & Isolation)', () => {
    test('接口不接收任何 apiKey 或 URL 字段，且不会向外传递未授权字段', async () => {
      const ipcMain = createFakeIpcMain()
      const sender = createFakeSender({ id: 600 })
      const mainWindow = createFakeMainWindow(sender)
      const runtime = createFakeRuntime()

      registerPromptEnhancementIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        runtime,
      })

      const event: PromptEnhancementInvokeEventLike = {
        sender,
        senderFrame: sender.mainFrame,
      }

      const input: PromptEnhancementInput = {
        requestId: 'req-clean-1',
        channelId: 'chan-safe',
        modelId: 'model-safe',
        draft: '请重构这段代码',
      }

      await ipcMain.invoke(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, event, input)

      const passedInput = runtime.calls.enhance[0]?.input as unknown as Record<string, unknown>
      expect(passedInput).toBeDefined()
      expect(passedInput['apiKey']).toBeUndefined()
      expect(passedInput['baseUrl']).toBeUndefined()
      expect(passedInput['url']).toBeUndefined()
    })
  })
})
