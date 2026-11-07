/**
 * 提示词增强 IPC 处理器注册模块
 *
 * 负责注册主进程提示词增强相关 IPC 通道：
 * - prompt-enhancement:enhance
 * - prompt-enhancement:cancel
 *
 * 核心安全特性与生命周期管理：
 * 1. 仅当前活跃主窗口且为其顶级 mainFrame 发起的调用才被允许；子 frame / 其他 webContents / 销毁的主窗口一律拒绝。
 * 2. 每个 owner 限制最多 2 个活跃并发请求，超限返回 { success: false, code: 'BUSY' }。
 * 3. 首次绑定每个 owner 的 did-start-navigation 与 destroyed 事件，同一 owner 重复请求绝不重复绑定 listener。
 * 4. 主 frame 跨文档导航 (isMainFrame && !isInPlace) 时取消该 owner 的未完成请求；同文档和子 frame 导航不取消。
 * 5. WebContents 销毁 (destroyed) 时取消该 owner 的未完成请求并清理注册表状态。
 * 6. cancel 严格按 event.sender.id (ownerId) 操作，不串台其他 owner。
 * 7. 纯类型接口注入依赖，接口不接受 API Key 或 URL，不打印任何敏感文本。
 */

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type {
  PromptEnhancementInput,
  PromptEnhancementResult,
} from './prompt-enhancement-service'

/**
 * 提示词增强 IPC 通道常量
 */
export const PROMPT_ENHANCEMENT_IPC_CHANNELS = {
  ENHANCE: 'prompt-enhancement:enhance',
  CANCEL: 'prompt-enhancement:cancel',
} as const

/**
 * 提示词增强 IPC 响应结果类型（包含并发受限时的 BUSY 码）
 */
export type PromptEnhancementIpcResult =
  | PromptEnhancementResult
  | { success: false; code: 'BUSY' }

/**
 * 结构化 Duck-type WebContents 接口（兼容 Electron.WebContents）
 */
export interface PromptEnhancementWebContentsLike {
  id: number
  mainFrame?: unknown
  on(
    event: 'did-start-navigation',
    listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
  ): this | void
  on(event: 'render-process-gone', listener: () => void): this | void
  once(event: 'destroyed', listener: () => void): this | void
}

/**
 * 结构化 Duck-type BrowserWindow 接口（兼容 Electron.BrowserWindow）
 */
export interface PromptEnhancementBrowserWindowLike {
  isDestroyed(): boolean
  webContents: PromptEnhancementWebContentsLike | WebContents
}

/**
 * 结构化 Duck-type IpcMainInvokeEvent 接口（兼容 Electron.IpcMainInvokeEvent）
 */
export interface PromptEnhancementInvokeEventLike {
  sender: PromptEnhancementWebContentsLike | WebContents
  senderFrame?: unknown
}

/**
 * 结构化 Duck-type IpcMain 接口（兼容 Electron.IpcMain）
 */
export interface PromptEnhancementIpcMainLike {
  handle(
    channel: string,
    listener: (event: PromptEnhancementInvokeEventLike, ...args: any[]) => Promise<any> | any
  ): void
  removeHandler?(channel: string): void
}

/**
 * 结构化 Duck-type Runtime 接口（兼容 PromptEnhancementRuntime）
 */
export interface PromptEnhancementRuntimeLike {
  getInFlightCount(ownerId: number): number
  enhance(ownerId: number, input: PromptEnhancementInput): Promise<PromptEnhancementResult>
  cancel(ownerId: number, requestId: string): boolean
  cancelOwner(ownerId: number): number
}

/**
 * 注册提示词增强 IPC 处理器所需的依赖参数
 */
export interface RegisterPromptEnhancementIpcOptions {
  ipcMain: PromptEnhancementIpcMainLike | IpcMain
  getMainWindow: () => PromptEnhancementBrowserWindowLike | BrowserWindow | null | undefined
  runtime: PromptEnhancementRuntimeLike
}

/**
 * 注册返回句柄，提供安全的反注册能力
 */
export interface PromptEnhancementIpcRegistration {
  dispose: () => void
}

/**
 * 注册提示词增强 IPC 处理器
 *
 * 文本仅在用户明确触发增强时发送；主进程保管渠道凭据。
 */
export function registerPromptEnhancementIpc(
  options: RegisterPromptEnhancementIpcOptions
): PromptEnhancementIpcRegistration {
  const { ipcMain, getMainWindow, runtime } = options

  const registeredPromptOwners = new Set<number>()

  const assertPromptSender = (event: PromptEnhancementInvokeEventLike): void => {
    const main = getMainWindow()
    if (
      !main ||
      main.isDestroyed() ||
      event.sender !== main.webContents ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof (event.senderFrame as { url?: unknown }).url !== 'string' ||
      !(event.senderFrame as { url: string }).url.startsWith('file:')
    ) {
      throw new Error('仅主窗口可以优化提示词。')
    }
    if (!registeredPromptOwners.has(event.sender.id)) {
      const sender = event.sender
      const ownerId = sender.id
      registeredPromptOwners.add(ownerId)
      sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
          runtime.cancelOwner(ownerId)
        }
      })
      sender.on('render-process-gone', () => runtime.cancelOwner(ownerId))
      sender.once('destroyed', () => {
        runtime.cancelOwner(ownerId)
        registeredPromptOwners.delete(ownerId)
      })
    }
  }

  const handleEnhance = async (
    event: PromptEnhancementInvokeEventLike,
    input: PromptEnhancementInput
  ): Promise<PromptEnhancementIpcResult> => {
    assertPromptSender(event)
    if (runtime.getInFlightCount(event.sender.id) >= 2) {
      return { success: false, code: 'BUSY' }
    }
    const raw = input && typeof input === 'object' ? input : {} as PromptEnhancementInput
    return runtime.enhance(event.sender.id, {
      requestId: raw.requestId, channelId: raw.channelId, modelId: raw.modelId, draft: raw.draft,
    })
  }

  const handleCancel = async (
    event: PromptEnhancementInvokeEventLike,
    requestId: string
  ): Promise<boolean> => {
    assertPromptSender(event)
    return runtime.cancel(event.sender.id, requestId)
  }

  ipcMain.handle(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE, handleEnhance)
  ipcMain.handle(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL, handleCancel)

  return {
    dispose: () => {
      if (typeof ipcMain.removeHandler === 'function') {
        ipcMain.removeHandler(PROMPT_ENHANCEMENT_IPC_CHANNELS.ENHANCE)
        ipcMain.removeHandler(PROMPT_ENHANCEMENT_IPC_CHANNELS.CANCEL)
      }
      registeredPromptOwners.clear()
    },
  }
}
