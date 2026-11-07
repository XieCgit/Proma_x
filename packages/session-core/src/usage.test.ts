import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@proma/shared'
import { summarizeSessionUsage } from './usage'

describe('summarizeSessionUsage', () => {
  describe('空数据与边界输入', () => {
    test('传入空数组返回全 0 且 isIncomplete 为 false', () => {
      const result = summarizeSessionUsage([])
      expect(result).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        resultsWithUsageCount: 0,
        isIncomplete: false,
      })
    })

    test('传入 null 或 undefined 安全返回全 0 统计', () => {
      expect(summarizeSessionUsage(null).totalTokens).toBe(0)
      expect(summarizeSessionUsage(undefined).totalTokens).toBe(0)
      expect(summarizeSessionUsage(null).isIncomplete).toBe(false)
    })

    test('传入非 Iterable 的异常参数安全返回全 0 统计', () => {
      expect(summarizeSessionUsage({} as unknown as SDKMessage[]).totalTokens).toBe(0)
      expect(summarizeSessionUsage(42 as unknown as SDKMessage[]).totalTokens).toBe(0)
    })

    test('仅包含 user/system 消息而无 result 消息时返回全 0', () => {
      const messages: SDKMessage[] = [
        { type: 'user', message: { content: [{ type: 'text', text: '你好' }] }, parent_tool_use_id: null },
        { type: 'system', subtype: 'init', model: 'gpt-4o' },
      ]
      const usage = summarizeSessionUsage(messages)
      expect(usage.totalTokens).toBe(0)
      expect(usage.resultsWithUsageCount).toBe(0)
      expect(usage.isIncomplete).toBe(false)
    })

    test('列表中包含 null、undefined、原始类型等脏数据时能安全跳过', () => {
      const messages = [
        null,
        undefined,
        'corrupted-line',
        12345,
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      ]
      const usage = summarizeSessionUsage(messages as unknown as SDKMessage[])
      expect(usage.inputTokens).toBe(50)
      expect(usage.outputTokens).toBe(25)
      expect(usage.totalTokens).toBe(75)
      expect(usage.resultsWithUsageCount).toBe(1)
      expect(usage.isIncomplete).toBe(false)
    })
  })

  describe('正常单轮与多轮对话', () => {
    test('单轮带有完整 prompt cache 字段的结果能精准累计各字段', () => {
      const messages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 1200,
            output_tokens: 350,
            cache_read_input_tokens: 4000,
            cache_creation_input_tokens: 800,
          },
        },
      ]
      const summary = summarizeSessionUsage(messages)
      expect(summary.inputTokens).toBe(1200)
      expect(summary.outputTokens).toBe(350)
      expect(summary.cacheReadTokens).toBe(4000)
      expect(summary.cacheCreationTokens).toBe(800)
      expect(summary.totalTokens).toBe(6350)
      expect(summary.resultsWithUsageCount).toBe(1)
      expect(summary.isIncomplete).toBe(false)
    })

    test('单轮仅有 input/output 时，省略的 cache 字段为 0 且总数正确', () => {
      const messages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 150,
            output_tokens: 80,
          },
        },
      ]
      const summary = summarizeSessionUsage(messages)
      expect(summary.inputTokens).toBe(150)
      expect(summary.outputTokens).toBe(80)
      expect(summary.cacheReadTokens).toBe(0)
      expect(summary.cacheCreationTokens).toBe(0)
      expect(summary.totalTokens).toBe(230)
      expect(summary.resultsWithUsageCount).toBe(1)
      expect(summary.isIncomplete).toBe(false)
    })

    test('多轮真实交互序列分别累计各分项并统计有效结果数', () => {
      const messages: SDKMessage[] = [
        // Turn 1
        { type: 'user', message: { content: [{ type: 'text', text: '问题 1' }] }, parent_tool_use_id: null },
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
        },
        // Turn 2
        { type: 'user', message: { content: [{ type: 'text', text: '问题 2' }] }, parent_tool_use_id: null },
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 200,
            output_tokens: 60,
            cache_read_input_tokens: 700,
            cache_creation_input_tokens: 0,
          },
        },
        // Turn 3
        { type: 'user', message: { content: [{ type: 'text', text: '问题 3' }] }, parent_tool_use_id: null },
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 300,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 150,
          },
        },
      ]

      const summary = summarizeSessionUsage(messages)
      expect(summary.inputTokens).toBe(600)
      expect(summary.outputTokens).toBe(200)
      expect(summary.cacheReadTokens).toBe(1200)
      expect(summary.cacheCreationTokens).toBe(350)
      expect(summary.totalTokens).toBe(2350)
      expect(summary.resultsWithUsageCount).toBe(3)
      expect(summary.isIncomplete).toBe(false)
    })
  })

  describe('跳过 Pi 合成压缩结果', () => {
    test('单条 isSyntheticCompactionResult: true 的内部 result 被完全跳过', () => {
      const messages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          isSyntheticCompactionResult: true,
          usage: {
            input_tokens: 50000,
            output_tokens: 1500,
            cache_read_input_tokens: 30000,
            cache_creation_input_tokens: 10000,
          },
        },
      ]

      const summary = summarizeSessionUsage(messages)
      expect(summary.totalTokens).toBe(0)
      expect(summary.resultsWithUsageCount).toBe(0)
      expect(summary.isIncomplete).toBe(false)
    })

    test('真实回合与合成结果混合时，仅累计真实回合 usage', () => {
      const messages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 200, output_tokens: 50 },
        },
        {
          type: 'result',
          subtype: 'success',
          isSyntheticCompactionResult: true,
          usage: { input_tokens: 80000, output_tokens: 4000 },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 300, output_tokens: 70 },
        },
      ]

      const summary = summarizeSessionUsage(messages)
      expect(summary.inputTokens).toBe(500)
      expect(summary.outputTokens).toBe(120)
      expect(summary.totalTokens).toBe(620)
      expect(summary.resultsWithUsageCount).toBe(2)
      expect(summary.isIncomplete).toBe(false)
    })
  })

  describe('绝不把 assistant usage 与 result 相加', () => {
    test('assistant 流式快照中的 usage 绝不计入，仅以 result 为准', () => {
      const messages: SDKMessage[] = [
        { type: 'user', message: { content: [{ type: 'text', text: '写一段代码' }] }, parent_tool_use_id: null },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '正在思考' }],
            usage: { input_tokens: 500, output_tokens: 30 },
          },
          parent_tool_use_id: null,
        } as unknown as SDKAssistantMessage,
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '完成实现' }],
            usage: { input_tokens: 500, output_tokens: 100 },
          },
          parent_tool_use_id: null,
        } as unknown as SDKAssistantMessage,
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 500, output_tokens: 100 },
        },
      ]

      const summary = summarizeSessionUsage(messages)
      expect(summary.inputTokens).toBe(500)
      expect(summary.outputTokens).toBe(100)
      expect(summary.totalTokens).toBe(600)
      expect(summary.resultsWithUsageCount).toBe(1)
      expect(summary.isIncomplete).toBe(false)
    })

    test('纯 assistant 消息构成的会话统计全为 0', () => {
      const messages: SDKMessage[] = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '未完成流式' }],
            usage: { input_tokens: 300, output_tokens: 80 },
          },
          parent_tool_use_id: null,
        } as unknown as SDKAssistantMessage,
      ]

      const summary = summarizeSessionUsage(messages)
      expect(summary.totalTokens).toBe(0)
      expect(summary.resultsWithUsageCount).toBe(0)
      expect(summary.isIncomplete).toBe(false)
    })
  })

  describe('畸形与残缺 usage 容错', () => {
    test('result 缺少 usage 字段时不计入有效结果数且 token 不增加', () => {
      const messages = [
        { type: 'result', subtype: 'success' },
        { type: 'result', subtype: 'error', usage: null },
        { type: 'result', subtype: 'error_max_turns', usage: 'corrupted-usage' },
      ]
      const summary = summarizeSessionUsage(messages as unknown as SDKMessage[])
      expect(summary.totalTokens).toBe(0)
      expect(summary.resultsWithUsageCount).toBe(0)
      expect(summary.isIncomplete).toBe(true)
    })

    test('usage 为空对象或所有字段均为非法值时跳过且不计入结果数', () => {
      const messages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          usage: {} as unknown as SDKResultMessage['usage'],
        },
        {
          type: 'result',
          subtype: 'error',
          usage: {
            input_tokens: NaN,
            output_tokens: -10,
          } as unknown as SDKResultMessage['usage'],
        },
      ]
      const summary = summarizeSessionUsage(messages)
      expect(summary.totalTokens).toBe(0)
      expect(summary.resultsWithUsageCount).toBe(0)
      expect(summary.isIncomplete).toBe(true)
    })

    test('部分字段合法、部分字段为负数/NaN/字符串时，合法字段累加，非法字段容错为 0', () => {
      const messages = [
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 300,
            output_tokens: -50,
            cache_read_input_tokens: NaN,
            cache_creation_input_tokens: 'invalid-string',
          },
        },
      ]
      const summary = summarizeSessionUsage(messages as unknown as SDKMessage[])
      expect(summary.inputTokens).toBe(300)
      expect(summary.outputTokens).toBe(0)
      expect(summary.cacheReadTokens).toBe(0)
      expect(summary.cacheCreationTokens).toBe(0)
      expect(summary.totalTokens).toBe(300)
      expect(summary.resultsWithUsageCount).toBe(1)
      expect(summary.isIncomplete).toBe(true)
    })

    test('包含有效 0 计数的 result 视为有效 usage 结果', () => {
      const messages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      ]
      const summary = summarizeSessionUsage(messages)
      expect(summary.totalTokens).toBe(0)
      expect(summary.resultsWithUsageCount).toBe(1)
      expect(summary.isIncomplete).toBe(false)
    })

    test('浮点数 token 计数向下取整', () => {
      const messages = [
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 100.8, output_tokens: 50.2 },
        },
      ]
      const summary = summarizeSessionUsage(messages as unknown as SDKMessage[])
      expect(summary.inputTokens).toBe(100)
      expect(summary.outputTokens).toBe(50)
      expect(summary.totalTokens).toBe(150)
      expect(summary.resultsWithUsageCount).toBe(1)
      expect(summary.isIncomplete).toBe(true)
    })
  })

  describe('不推断消重（避免误删真实回合）', () => {
    test('多个完全相同 usage 的真实 result 均被正常独立累计', () => {
      const messages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 200, output_tokens: 50 },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 200, output_tokens: 50 },
        },
      ]

      const summary = summarizeSessionUsage(messages)
      expect(summary.inputTokens).toBe(400)
      expect(summary.outputTokens).toBe(100)
      expect(summary.totalTokens).toBe(500)
      expect(summary.resultsWithUsageCount).toBe(2)
      expect(summary.isIncomplete).toBe(false)
    })
  })

  describe('不安全数字与加法溢出保护', () => {
    test('检测到超过 MAX_SAFE_INTEGER 的数值或 Infinity 时设置 isIncomplete 为 true 且不产生 Infinity', () => {
      const messages = [
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 100,
            output_tokens: Infinity,
          },
        },
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 1e25,
            output_tokens: 50,
          },
        },
      ]

      const summary = summarizeSessionUsage(messages as unknown as SDKMessage[])
      expect(summary.isIncomplete).toBe(true)
      expect(Number.isFinite(summary.totalTokens)).toBe(true)
      expect(summary.totalTokens).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
      expect(summary.inputTokens).toBe(100)
      expect(summary.outputTokens).toBe(50)
      expect(summary.totalTokens).toBe(150)
      expect(summary.resultsWithUsageCount).toBe(2)
    })

    test('累加达到安全整数上限时截断在 MAX_SAFE_INTEGER 并标记 isIncomplete', () => {
      const messages = [
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: Number.MAX_SAFE_INTEGER,
            output_tokens: 10,
          },
        },
      ]

      const summary = summarizeSessionUsage(messages as unknown as SDKMessage[])
      expect(summary.isIncomplete).toBe(true)
      expect(summary.totalTokens).toBe(Number.MAX_SAFE_INTEGER)
      expect(summary.inputTokens).toBe(Number.MAX_SAFE_INTEGER)
      expect(summary.outputTokens).toBe(10)
    })
  })
})
