import type { AgentAssistantDelta, SDKAssistantMessage, SDKContentBlock } from '@proma/shared'

export interface InterruptedAssistantMessage extends SDKAssistantMessage {
  _promaInterrupted: true
  _promaInterruptedTruncated: boolean
}

export interface AcceptInput {
  uuid: string
  delta: AgentAssistantDelta
  session_id?: string
}

export interface InterruptedOutputBufferOptions {
  /** 单个 UUID 允许的最大文本 UTF-8 字节数，默认 128KB (131,072 字节) */
  maxBytesPerUuid?: number
  /** 最大保留的不同 UUID 个数，默认 100 */
  maxUuids?: number
  /** 允许的最大 contentIndex，默认 1024 */
  maxContentIndex?: number
}

export const DEFAULT_MAX_BYTES_PER_UUID = 128 * 1024
export const DEFAULT_MAX_UUIDS = 100
export const DEFAULT_MAX_CONTENT_INDEX = 1024

interface UuidEntry {
  uuid: string
  sessionId?: string
  blocks: Map<number, string>
  truncated: boolean
}

/**
 * 安全二分截断字符串至指定的 UTF-8 字节上限，保证不会破坏多字节 Unicode 字符。
 */
function truncateUtf8Safe(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str

  let low = 0
  let high = str.length
  let best = ''

  while (low <= high) {
    const mid = (low + high) >> 1
    const slice = str.slice(0, mid)
    if (Buffer.byteLength(slice, 'utf8') <= maxBytes) {
      best = slice
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  // 不要在 UTF-16 surrogate pair 的中间截断；孤立高代理会被渲染成替换字符。
  const last = best.charCodeAt(best.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) best = best.slice(0, -1)
  return best
}

function isValidContentIndex(index: unknown, maxIndex: number): index is number {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= maxIndex
}

function isValidString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0
}

/**
 * 纯内存未完成可见文本输出缓冲。
 *
 * 职责：
 * 1. 在流式过程中累积可见文本（text），严格隔离并忽略 thinking 与 toolcall 等隐藏推理或敏感数据；
 * 2. 对每个 UUID 和 contentIndex 保证隔离与顺序；
 * 3. 严格限制单个 UUID 内存占用（默认 128KB）与 UUID 上限，超限明确标记截断（_promaInterruptedTruncated），不得静默截断；
 * 4. 收到 start 时清除同 UUID 旧轮次；收到 complete 时移除已完成消息；
 * 5. drain 时清空并转出 SDKAssistantMessage 兼容对象，全空白内容不产出消息。
 */
export class InterruptedOutputBuffer {
  private readonly maxBytesPerUuid: number
  private readonly maxUuids: number
  private readonly maxContentIndex: number
  private readonly entries = new Map<string, UuidEntry>()

  constructor(options: InterruptedOutputBufferOptions = {}) {
    this.maxBytesPerUuid =
      typeof options.maxBytesPerUuid === 'number' && options.maxBytesPerUuid > 0
        ? options.maxBytesPerUuid
        : DEFAULT_MAX_BYTES_PER_UUID
    this.maxUuids =
      typeof options.maxUuids === 'number' && options.maxUuids > 0
        ? options.maxUuids
        : DEFAULT_MAX_UUIDS
    this.maxContentIndex =
      typeof options.maxContentIndex === 'number' && options.maxContentIndex >= 0
        ? options.maxContentIndex
        : DEFAULT_MAX_CONTENT_INDEX
  }

  /**
   * 当前缓存的 UUID 条目数。
   */
  get size(): number {
    return this.entries.size
  }

  /**
   * 接收增量事件。
   */
  accept(input: AcceptInput): void {
    if (!input || typeof input !== 'object') return

    const { uuid, delta, session_id } = input
    if (!isValidString(uuid) || uuid.length > 256) return
    if (!delta || typeof delta !== 'object' || typeof delta.type !== 'string') return

    const deltaType = delta.type

    // 仅保存 text，不保存 thinking、toolcall；禁止处理或记录任何隐藏推理/敏感日志
    if (deltaType.startsWith('thinking_') || deltaType.startsWith('toolcall_')) {
      return
    }

    if (deltaType === 'start') {
      // start 表示同 UUID 新一轮/重试开始，清除该 UUID 避免重复
      this.entries.delete(uuid)
      return
    }

    if (
      deltaType !== 'text_start' &&
      deltaType !== 'text_delta' &&
      deltaType !== 'text_end'
    ) {
      return
    }

    const contentIndex = (delta as { contentIndex?: unknown }).contentIndex
    if (!isValidContentIndex(contentIndex, this.maxContentIndex)) return

    let entry = this.entries.get(uuid)
    if (!entry) {
      // 保持条目有界，超出最大 UUID 数量时逐出最旧的条目
      if (this.entries.size >= this.maxUuids) {
        const oldestKey = this.entries.keys().next().value
        if (oldestKey !== undefined) {
          this.entries.delete(oldestKey)
        }
      }

      entry = {
        uuid,
        sessionId: typeof session_id === 'string' ? session_id : undefined,
        blocks: new Map<number, string>(),
        truncated: false,
      }
      this.entries.set(uuid, entry)
    } else if (typeof session_id === 'string' && session_id.length > 0) {
      entry.sessionId = session_id
    }

    switch (deltaType) {
      case 'text_start': {
        // text_start 标记该 block 开始，如果尚不存在则初始化
        if (!entry.blocks.has(contentIndex)) {
          entry.blocks.set(contentIndex, '')
        }
        break
      }

      case 'text_delta': {
        const textDelta = (delta as { delta?: unknown }).delta
        if (typeof textDelta !== 'string' || textDelta.length === 0) {
          return
        }

        const oldBlock = entry.blocks.get(contentIndex) ?? ''
        const oldBlockBytes = Buffer.byteLength(oldBlock, 'utf8')
        const currentTotalBytesWithoutOld = this.getUuidTotalBytes(entry) - oldBlockBytes
        const proposedBlock = oldBlock + textDelta
        const proposedBlockBytes = Buffer.byteLength(proposedBlock, 'utf8')

        if (currentTotalBytesWithoutOld + proposedBlockBytes <= this.maxBytesPerUuid) {
          entry.blocks.set(contentIndex, proposedBlock)
        } else {
          entry.truncated = true
          const allowedForThisBlock = Math.max(0, this.maxBytesPerUuid - currentTotalBytesWithoutOld)
          const truncatedBlock = truncateUtf8Safe(proposedBlock, allowedForThisBlock)
          entry.blocks.set(contentIndex, truncatedBlock)
        }
        break
      }

      case 'text_end': {
        // text_end 的完整 content 应替换而非叠加 delta
        const content = (delta as { content?: unknown }).content
        if (typeof content !== 'string') {
          return
        }

        const oldBlock = entry.blocks.get(contentIndex) ?? ''
        const oldBlockBytes = Buffer.byteLength(oldBlock, 'utf8')
        const currentTotalBytesWithoutOld = this.getUuidTotalBytes(entry) - oldBlockBytes
        const proposedBlockBytes = Buffer.byteLength(content, 'utf8')

        if (currentTotalBytesWithoutOld + proposedBlockBytes <= this.maxBytesPerUuid) {
          entry.blocks.set(contentIndex, content)
        } else {
          entry.truncated = true
          const allowedForThisBlock = Math.max(0, this.maxBytesPerUuid - currentTotalBytesWithoutOld)
          const truncatedBlock = truncateUtf8Safe(content, allowedForThisBlock)
          entry.blocks.set(contentIndex, truncatedBlock)
        }
        break
      }
    }
  }

  /**
   * 清除已收到完整 assistant 消息的缓存。
   */
  complete(uuid: string): void {
    if (typeof uuid !== 'string' || uuid.length === 0) return
    this.entries.delete(uuid)
  }

  /**
   * 将未完成可见非空文本转换为 SDKAssistantMessage 兼容对象，并清空缓冲区。
   * 全空白文本不产出消息。
   */
  drain(): InterruptedAssistantMessage[] {
    if (this.entries.size === 0) {
      return []
    }

    const messages: InterruptedAssistantMessage[] = []

    for (const entry of this.entries.values()) {
      // 按 contentIndex 严格升序排序
      const sortedIndices = Array.from(entry.blocks.keys()).sort((a, b) => a - b)
      const contentBlocks: SDKContentBlock[] = []
      let hasVisibleNonWhitespace = false

      for (const idx of sortedIndices) {
        const text = entry.blocks.get(idx) ?? ''
        if (text.length > 0) {
          contentBlocks.push({ type: 'text', text })
          if (text.trim().length > 0) {
            hasVisibleNonWhitespace = true
          }
        }
      }

      // 空白文本不产生消息
      if (!hasVisibleNonWhitespace || contentBlocks.length === 0) {
        continue
      }

      messages.push({
        type: 'assistant',
        uuid: entry.uuid,
        session_id: entry.sessionId,
        parent_tool_use_id: null,
        message: {
          content: contentBlocks,
        },
        _promaInterrupted: true,
        _promaInterruptedTruncated: entry.truncated,
      })
    }

    this.entries.clear()
    return messages
  }

  /**
   * 计算指定条目在内存中的总 UTF-8 字节数。
   */
  private getUuidTotalBytes(entry: UuidEntry): number {
    let total = 0
    for (const block of entry.blocks.values()) {
      total += Buffer.byteLength(block, 'utf8')
    }
    return total
  }
}

/**
 * 便捷工厂函数。
 */
export function createInterruptedOutputBuffer(
  options?: InterruptedOutputBufferOptions,
): InterruptedOutputBuffer {
  return new InterruptedOutputBuffer(options)
}
