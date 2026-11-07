/**
 * 提示词优化请求管理器 (Prompt Enhancement Service)
 *
 * 核心特性：
 * - 纯内存依赖注入架构，无硬编码、无真实网络或磁盘依赖
 * - 严格边界校验（ID 长度 <= 256，draft 长度 <= 12000，参数非空）
 * - 仅允许启用且属于对应渠道的模型（依赖注入 isModelAllowed）
 * - 基于 ownerId + requestId 的重复请求拦截与跨 owner 隔离
 * - 独立 AbortController 取消与超时机制（默认 60 秒）
 * - 防悬挂保护：即使注入的 complete 忽略 AbortSignal 挂起，超时或取消时仍立即终结 Promise 并清理 Map
 * - 安全性：绝不记录 draft，绝不向外部响应透出 provider 内部错误详情、堆栈或凭据
 */

export const DEFAULT_PROMPT_ENHANCEMENT_TIMEOUT_MS = 60_000
export const MAX_ID_LENGTH = 256
export const MAX_DRAFT_LENGTH = 12_000

export type PromptEnhancementErrorCode =
  | 'INVALID_INPUT'
  | 'MODEL_NOT_ALLOWED'
  | 'DUPLICATE_REQUEST'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'DESTROYED'

export type PromptEnhancementResult =
  | { success: true; text: string }
  | { success: false; code: PromptEnhancementErrorCode }

export interface PromptEnhancementInput {
  requestId: string
  channelId: string
  modelId: string
  draft: string
}

export interface PromptEnhancementCompleteInput {
  channelId: string
  modelId: string
  draft: string
  signal: AbortSignal
}

export interface PromptEnhancementDeps {
  isModelAllowed: (channelId: string, modelId: string) => boolean | Promise<boolean>
  complete: (input: PromptEnhancementCompleteInput) => Promise<string>
}

export interface PromptEnhancementOptions {
  timeoutMs?: number
}

interface ActiveRequestEntry {
  controller: AbortController
  settle: (result: PromptEnhancementResult) => void
}

export class PromptEnhancementService {
  private activeRequests = new Map<number, Map<string, ActiveRequestEntry>>()
  // 已取消但底层依赖尚未返回时仍计入并发水位，避免反复取消绕过限流。
  private inFlightByOwner = new Map<number, number>()
  private timeoutMs: number
  private destroyed = false

  constructor(
    private readonly deps: PromptEnhancementDeps,
    options?: PromptEnhancementOptions,
  ) {
    const customTimeout = options?.timeoutMs
    this.timeoutMs =
      typeof customTimeout === 'number' && Number.isFinite(customTimeout) && customTimeout > 0
        ? customTimeout
        : DEFAULT_PROMPT_ENHANCEMENT_TIMEOUT_MS
  }

  /**
   * 校验输入参数合法性
   */
  private validateInput(ownerId: number, input: unknown): input is PromptEnhancementInput {
    if (typeof ownerId !== 'number' || !Number.isFinite(ownerId)) {
      return false
    }

    if (!input || typeof input !== 'object') {
      return false
    }

    const { requestId, channelId, modelId, draft } = input as Record<string, unknown>

    if (
      typeof requestId !== 'string' ||
      requestId.trim().length === 0 ||
      requestId.length > MAX_ID_LENGTH
    ) {
      return false
    }

    if (
      typeof channelId !== 'string' ||
      channelId.trim().length === 0 ||
      channelId.length > MAX_ID_LENGTH
    ) {
      return false
    }

    if (
      typeof modelId !== 'string' ||
      modelId.trim().length === 0 ||
      modelId.length > MAX_ID_LENGTH
    ) {
      return false
    }

    if (
      typeof draft !== 'string' ||
      draft.trim().length === 0 ||
      draft.length > MAX_DRAFT_LENGTH
    ) {
      return false
    }

    return true
  }

  /**
   * 从活跃请求 Map 中安全移除指定条目
   */
  private removeActive(ownerId: number, requestId: string): void {
    const ownerMap = this.activeRequests.get(ownerId)
    if (!ownerMap) return
    ownerMap.delete(requestId)
    if (ownerMap.size === 0) {
      this.activeRequests.delete(ownerId)
    }
  }

  /**
   * 发起提示词优化请求
   */
  async enhance(ownerId: number, input: PromptEnhancementInput): Promise<PromptEnhancementResult> {
    if (this.destroyed) {
      return { success: false, code: 'DESTROYED' }
    }

    if (!this.validateInput(ownerId, input)) {
      return { success: false, code: 'INVALID_INPUT' }
    }

    const { requestId, channelId, modelId, draft } = input

    let ownerMap = this.activeRequests.get(ownerId)
    if (!ownerMap) {
      ownerMap = new Map<string, ActiveRequestEntry>()
      this.activeRequests.set(ownerId, ownerMap)
    }

    if (ownerMap.has(requestId)) {
      return { success: false, code: 'DUPLICATE_REQUEST' }
    }

    const controller = new AbortController()

    return new Promise<PromptEnhancementResult>((resolve) => {
      let timerId: ReturnType<typeof setTimeout> | null = null
      let settled = false

      const settle = (result: PromptEnhancementResult) => {
        if (settled) return
        settled = true

        if (timerId !== null) {
          clearTimeout(timerId)
          timerId = null
        }

        this.removeActive(ownerId, requestId)
        resolve(result)
      }

      // 超时定时器
      timerId = setTimeout(() => {
        try {
          controller.abort()
        } catch {
          // 忽略 abort 异常
        }
        settle({ success: false, code: 'TIMEOUT' })
      }, this.timeoutMs)

      // 注册活跃条目；即使对外已取消，后台清理结束前依然计入在途数。
      this.inFlightByOwner.set(ownerId, (this.inFlightByOwner.get(ownerId) ?? 0) + 1)
      const entry: ActiveRequestEntry = {
        controller,
        settle,
      }
      ownerMap.set(requestId, entry)

      // 异步执行主链路
      void (async () => {
        // 1. 验证模型是否启用且属于当前渠道
        let isAllowed = false
        try {
          // 保持同步校验的即时启动语义；只有字面量 true 才算通过授权。
          const result = this.deps.isModelAllowed(channelId, modelId)
          isAllowed = typeof result === 'boolean' ? result === true : (await result) === true
        } catch {
          if (settled) return
          settle({ success: false, code: 'MODEL_NOT_ALLOWED' })
          return
        }

        if (settled) return

        if (!isAllowed) {
          settle({ success: false, code: 'MODEL_NOT_ALLOWED' })
          return
        }

        // 2. 调用注入的 complete
        try {
          const text = await this.deps.complete({
            channelId,
            modelId,
            draft,
            signal: controller.signal,
          })

          if (settled) return

          if (typeof text === 'string') {
            settle({ success: true, text })
          } else {
            settle({ success: false, code: 'PROVIDER_ERROR' })
          }
        } catch {
          if (settled) return
          // 安全保护：脱敏处理，绝不向响应透出 provider 原始错误详情或凭据
          settle({ success: false, code: 'PROVIDER_ERROR' })
        }
      })().catch(() => {
        settle({ success: false, code: 'PROVIDER_ERROR' })
      }).finally(() => {
        const remaining = (this.inFlightByOwner.get(ownerId) ?? 1) - 1
        if (remaining > 0) this.inFlightByOwner.set(ownerId, remaining)
        else this.inFlightByOwner.delete(ownerId)
      })
    })
  }

  /** 底层请求尚未结束的数量，包括已取消但仍在清理的请求。 */
  getInFlightCount(ownerId: number): number {
    return this.inFlightByOwner.get(ownerId) ?? 0
  }

  /**
   * 取消指定 owner 和 requestId 的正在执行中的请求
   */
  cancel(ownerId: number, requestId: string): boolean {
    if (typeof ownerId !== 'number' || typeof requestId !== 'string') {
      return false
    }

    const ownerMap = this.activeRequests.get(ownerId)
    if (!ownerMap) return false

    const entry = ownerMap.get(requestId)
    if (!entry) return false

    try {
      entry.controller.abort()
    } catch {
      // 忽略 abort 异常
    }

    entry.settle({ success: false, code: 'CANCELLED' })
    return true
  }

  /**
   * 取消指定 owner 下的所有活跃请求
   */
  cancelOwner(ownerId: number): number {
    if (typeof ownerId !== 'number') return 0

    const ownerMap = this.activeRequests.get(ownerId)
    if (!ownerMap) return 0

    const entries = Array.from(ownerMap.values())
    for (const entry of entries) {
      try {
        entry.controller.abort()
      } catch {
        // 忽略 abort 异常
      }
      entry.settle({ success: false, code: 'CANCELLED' })
    }

    return entries.length
  }

  /**
   * 获取当前活跃请求数（可按 owner 过滤）
   */
  getActiveCount(ownerId?: number): number {
    if (typeof ownerId === 'number') {
      return this.activeRequests.get(ownerId)?.size ?? 0
    }

    let total = 0
    for (const ownerMap of this.activeRequests.values()) {
      total += ownerMap.size
    }
    return total
  }

  /**
   * 销毁服务并终结所有进行中的请求与资源
   */
  destroy(): void {
    this.destroyed = true
    for (const ownerMap of this.activeRequests.values()) {
      const entries = Array.from(ownerMap.values())
      for (const entry of entries) {
        try {
          entry.controller.abort()
        } catch {
          // 忽略 abort 异常
        }
        entry.settle({ success: false, code: 'DESTROYED' })
      }
    }
    this.activeRequests.clear()
  }
}

/**
 * 工厂函数：创建 PromptEnhancementService 实例
 */
export function createPromptEnhancementService(
  deps: PromptEnhancementDeps,
  options?: PromptEnhancementOptions,
): PromptEnhancementService {
  return new PromptEnhancementService(deps, options)
}
