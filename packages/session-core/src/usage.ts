import type { SDKMessage } from '@proma/shared'

/**
 * 会话 Token 汇总统计结果。
 * 纯内存对象，无 IO 依赖，浏览器与 Node 环境双向安全。
 */
export interface SessionTokenUsage {
  /** 累计输入 Token 数（不含 Prompt Cache 读取与写入） */
  inputTokens: number
  /** 累计输出 Token 数 */
  outputTokens: number
  /** 累计 Prompt Cache 读取 Token 数 */
  cacheReadTokens: number
  /** 累计 Prompt Cache 创建/写入 Token 数 */
  cacheCreationTokens: number
  /** 累计所有 Token 总和 (input + output + cacheRead + cacheCreation) */
  totalTokens: number
  /** 具有有效 usage 并被成功计入统计的 result 消息数量 */
  resultsWithUsageCount: number
  /**
   * 是否存在不完整/不精确数据标记。
   * 当真实 result 缺少计量数据、包含无效数值或累加溢出时置为 true。
   */
  isIncomplete: boolean
}

/**
 * 构造全 0 的空 SessionTokenUsage 初始对象。
 */
function createEmptySessionUsage(): SessionTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    resultsWithUsageCount: 0,
    isIncomplete: false,
  }
}

interface ParsedTokenField {
  value: number
  isValid: boolean
  isUnsafe: boolean
}

/**
 * 解析并清洗单个 Token 计数字段。
 * - 负数、NaN、非数字类型等普通畸形值容错返回 0，标记 isValid: false
 * - 小数向下取整
 * - Infinity 或超过 MAX_SAFE_INTEGER 的数值标记 isUnsafe: true，value 截断为 0，避免污染计算
 */
function parseTokenField(raw: unknown): ParsedTokenField {
  if (typeof raw !== 'number' || Number.isNaN(raw) || raw < 0) {
    return { value: 0, isValid: false, isUnsafe: false }
  }
  if (!Number.isFinite(raw) || raw > Number.MAX_SAFE_INTEGER) {
    return { value: 0, isValid: false, isUnsafe: true }
  }
  return { value: Math.floor(raw), isValid: true, isUnsafe: !Number.isInteger(raw) }
}

/**
 * 安全累加，防止超过 Number.MAX_SAFE_INTEGER 或产生精度失真。
 */
function safeAdd(current: number, add: number): { next: number; overflow: boolean } {
  if (current > Number.MAX_SAFE_INTEGER - add) {
    return { next: Number.MAX_SAFE_INTEGER, overflow: true }
  }
  return { next: current + add, overflow: false }
}

/**
 * 汇总会话消息列表中的 Token 消耗总量。
 *
 * 【核心设计与安全规范】
 * 1. 纯计算函数，无任何网络或文件 IO，浏览器与 Node 环境双向安全。
 * 2. 仅累计 `type === 'result'` 且未被标记为 `isSyntheticCompactionResult` 的有效 usage。
 * 3. 绝不累计 `assistant` 消息的 usage：避免快照切片与终态 result 产生重复相加。
 * 4. 跳过 Pi 手动上下文压缩用于收束流的合成结果（`isSyntheticCompactionResult: true`）。
 * 5. 无法从缺少稳定唯一 ID 的 result 消息推断重复，因此不执行任何可能误删真实回合的激进消重。
 * 6. 严谨容错：对缺失、非有限数、负数值和畸形对象进行安全隔离与容错，不抛出异常。
 * 7. 数字安全保证：检测到不安全数字或累加溢出时设置 `isIncomplete: true`，绝不产生 Infinity 或超出 MAX_SAFE_INTEGER 的误导性总数。
 * 8. 不硬编码任何具体模型或价格规则，保持为纯粹的 Token 计量工具。
 *
 * @param messages 消息只读数组（为 null/undefined/非数组时返回全 0）
 * @returns 统计后的 SessionTokenUsage 对象
 */
export function summarizeSessionUsage(
  messages: readonly (SDKMessage | unknown)[] | null | undefined,
): SessionTokenUsage {
  if (!messages || typeof (messages as Iterable<unknown>)[Symbol.iterator] !== 'function') {
    return createEmptySessionUsage()
  }

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let validResultCount = 0
  let isIncomplete = false

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') {
      continue
    }

    const msg = raw as Record<string, unknown>

    // 仅累计 type === 'result' 的消息，绝不把 assistant usage 与 result 相加
    if (msg.type !== 'result') {
      continue
    }

    // 跳过 Pi 内部手动压缩收束流的合成结果，不对应真实模型调用
    if (msg.isSyntheticCompactionResult === true) {
      continue
    }

    const usage = msg.usage
    if (!usage || typeof usage !== 'object') {
      // 缺少计量数据不能展示为完整统计。
      isIncomplete = true
      continue
    }

    const usageObj = usage as Record<string, unknown>

    const parsedInput = parseTokenField(usageObj.input_tokens)
    const parsedOutput = parseTokenField(usageObj.output_tokens)
    const parsedCacheRead = parseTokenField(usageObj.cache_read_input_tokens)
    const parsedCacheCreation = parseTokenField(usageObj.cache_creation_input_tokens)

    // 检查是否存在至少一个有效声明的字段
    const hasValidField =
      parsedInput.isValid ||
      parsedOutput.isValid ||
      parsedCacheRead.isValid ||
      parsedCacheCreation.isValid

    // input/output 为必要字段；可选缓存字段只在提供了无效值时标记不完整。
    if (
      !parsedInput.isValid || !parsedOutput.isValid ||
      (usageObj.cache_read_input_tokens !== undefined && !parsedCacheRead.isValid) ||
      (usageObj.cache_creation_input_tokens !== undefined && !parsedCacheCreation.isValid) ||
      parsedInput.isUnsafe || parsedOutput.isUnsafe ||
      parsedCacheRead.isUnsafe || parsedCacheCreation.isUnsafe
    ) {
      isIncomplete = true
    }
    if (!hasValidField) continue

    validResultCount++

    const rInput = safeAdd(inputTokens, parsedInput.value)
    inputTokens = rInput.next
    if (rInput.overflow) isIncomplete = true

    const rOutput = safeAdd(outputTokens, parsedOutput.value)
    outputTokens = rOutput.next
    if (rOutput.overflow) isIncomplete = true

    const rCacheRead = safeAdd(cacheReadTokens, parsedCacheRead.value)
    cacheReadTokens = rCacheRead.next
    if (rCacheRead.overflow) isIncomplete = true

    const rCacheCreation = safeAdd(cacheCreationTokens, parsedCacheCreation.value)
    cacheCreationTokens = rCacheCreation.next
    if (rCacheCreation.overflow) isIncomplete = true
  }

  // 汇总总 token 并防止加法溢出
  let totalTokens = 0
  for (const val of [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens]) {
    const acc = safeAdd(totalTokens, val)
    totalTokens = acc.next
    if (acc.overflow) isIncomplete = true
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    resultsWithUsageCount: validResultCount,
    isIncomplete,
  }
}
