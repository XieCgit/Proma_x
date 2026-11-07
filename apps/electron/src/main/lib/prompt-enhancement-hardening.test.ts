import { describe, expect, mock, test } from 'bun:test'
import { getAdapter } from '@proma/core'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/unused' },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => undefined },
}))
const { createSafeAdapter, createSafeFetchFn, MAX_ENHANCEMENT_RESPONSE_BYTES } = await import('./prompt-enhancement-runtime')

describe('提示词增强请求的安全包装', () => {
  test('保留真实供应商类实例的原型方法', () => {
    const adapter = createSafeAdapter(getAdapter('anthropic'))
    expect(typeof adapter.buildStreamRequest).toBe('function')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://api.anthropic.com', apiKey: 'test-key', modelId: 'test-model',
      history: [], userMessage: '草稿', systemMessage: '优化', readImageAttachments: () => [],
    })
    expect(new URL(request.url).origin).toBe('https://api.anthropic.com')
  })

  test('没有换行的过长响应也被原始字节预算中断', async () => {
    const fakeFetch = (async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_ENHANCEMENT_RESPONSE_BYTES + 1)); controller.close() },
    }), { status: 200 })) as unknown as typeof fetch
    const response = await createSafeFetchFn(fakeFetch)('https://example.invalid')
    await expect(response.arrayBuffer()).rejects.toThrow('Stream size limit exceeded')
  })

  test('底层 AbortError 也不会原样暴露可能携带的敏感文本', async () => {
    const fakeFetch = (async () => {
      const error = new Error('key secret and draft contents')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof fetch
    const fn = createSafeFetchFn(fakeFetch)
    try {
      await fn('https://example.invalid')
      throw new Error('unexpected success')
    } catch (error) {
      expect(String(error)).not.toContain('secret')
      expect((error as Error).name).toBe('AbortError')
    }
  })
})
