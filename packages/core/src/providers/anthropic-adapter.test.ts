import { describe, expect, test, spyOn } from 'bun:test'
import type { ProviderType } from '@proma/shared'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { setPromaVersion } from './user-agent.ts'

function buildRequest(provider: ProviderType, apiKey = 'test-key') {
  const adapter = new AnthropicAdapter(provider)
  const baseUrl = provider === 'xiaomi-token-plan'
    ? 'https://token-plan-cn.xiaomimimo.com/anthropic'
    : provider === 'qwen-token-plan'
      ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages'
      : provider === 'zhipu-coding-team'
      ? 'https://open.bigmodel.cn/api/anthropic'
      : 'https://api.xiaomimimo.com/anthropic'

  return adapter.buildStreamRequest({
    baseUrl,
    apiKey,
    modelId: 'mimo-v2.6-pro',
    history: [],
    userMessage: 'ping',
    readImageAttachments: () => [],
  })
}

describe('AnthropicAdapter headers', () => {
  test('xiaomi API uses api-key authentication', () => {
    const request = buildRequest('xiaomi')

    expect(request.headers['api-key']).toBe('test-key')
    expect(request.headers.Authorization).toBeUndefined()
    expect(request.headers['User-Agent']).toBeUndefined()
  })

  test('xiaomi token plan keeps bearer authentication with Proma User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('xiaomi-token-plan')

    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })

  test('qwen token plan uses the complete Anthropic endpoint with bearer authentication and Proma User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('qwen-token-plan')

    expect(request.url).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['x-api-key']).toBeUndefined()
  })

  test('zhipu team plan uses apiKey from JSON for model calls', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest(
      'zhipu-coding-team',
      '{"apiKey":"model-key","organization":"org","project":"proj"}',
    )

    expect(request.headers.Authorization).toBe('Bearer model-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })
})

describe('AnthropicAdapter 调试日志安全脱敏 (PROMA_DEBUG_REQUEST / PROMA_DEBUG_SSE)', () => {
  test('Given 启用 PROMA_DEBUG_REQUEST When buildStreamRequest Then 仅输出 provider/model 元数据，不泄露草稿与请求 JSON', () => {
    const adapter = new AnthropicAdapter('anthropic')
    const originalEnv = process.env.PROMA_DEBUG_REQUEST
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    try {
      process.env.PROMA_DEBUG_REQUEST = 'true'

      const secretDraft = 'CLASSIFIED_PROMPT_KEYWORD_8899'
      adapter.buildStreamRequest({
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'FAKE_ANTHROPIC_TEST_KEY_4455',
        modelId: 'claude-3-7-sonnet',
        history: [],
        userMessage: secretDraft,
        readImageAttachments: () => [],
      })

      expect(logSpy).toHaveBeenCalled()
      const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')

      // 验证仅输出结构元数据
      expect(allLogs).toContain('[Request]')
      expect(allLogs).toContain('anthropic')
      expect(allLogs).not.toContain('claude-3-7-sonnet')

      // 验证绝不泄露草稿、key 或完整的 JSON 请求体
      expect(allLogs).not.toContain(secretDraft)
      expect(allLogs).not.toContain('FAKE_ANTHROPIC_TEST_KEY_4455')
      expect(allLogs).not.toContain('"messages"')
      expect(allLogs).not.toContain('→')
    } finally {
      if (originalEnv === undefined) {
        delete process.env.PROMA_DEBUG_REQUEST
      } else {
        process.env.PROMA_DEBUG_REQUEST = originalEnv
      }
      logSpy.mockRestore()
    }
  })

  test('Given 启用 PROMA_DEBUG_SSE When parseSSELine Then 仅输出 provider 与 event.type，不泄露文本响应或原始 JSON', () => {
    const adapter = new AnthropicAdapter('anthropic')
    const originalEnv = process.env.PROMA_DEBUG_SSE
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    try {
      process.env.PROMA_DEBUG_SSE = 'true'

      const secretResponse = 'TOP_SECRET_MODEL_OUTPUT_2233'
      const sseLine = JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: secretResponse,
        },
      })

      const events = adapter.parseSSELine(sseLine)
      expect(events).toEqual([{ type: 'chunk', delta: secretResponse }])

      expect(logSpy).toHaveBeenCalled()
      const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')

      // 验证仅输出元数据：供应商与事件类型
      expect(allLogs).toContain('[SSE]')
      expect(allLogs).toContain('anthropic')
      expect(allLogs).toContain('content_block_delta')

      // 验证绝不泄露模型输出内容或原始 JSON
      expect(allLogs).not.toContain(secretResponse)
      expect(allLogs).not.toContain('text_delta')
      expect(allLogs).not.toContain('index')
    } finally {
      if (originalEnv === undefined) {
        delete process.env.PROMA_DEBUG_SSE
      } else {
        process.env.PROMA_DEBUG_SSE = originalEnv
      }
      logSpy.mockRestore()
    }
  })
})
