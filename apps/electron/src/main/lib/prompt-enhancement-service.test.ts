import { describe, expect, test } from 'bun:test'
import {
  createPromptEnhancementService,
  PromptEnhancementService,
  DEFAULT_PROMPT_ENHANCEMENT_TIMEOUT_MS,
  MAX_ID_LENGTH,
  MAX_DRAFT_LENGTH,
} from './prompt-enhancement-service'

describe('PromptEnhancementService (提示词优化请求管理器)', () => {
  test('取消后忽略 signal 的后台调用仍计入并发水位，实际结束才释放', async () => {
    let finish: ((text: string) => void) | undefined
    const service = new PromptEnhancementService({
      isModelAllowed: () => true,
      complete: () => new Promise<string>((resolve) => { finish = resolve }),
    })
    const result = service.enhance(7, { requestId: 'a', channelId: 'c', modelId: 'm', draft: 'draft' })
    expect(service.getInFlightCount(7)).toBe(1)
    expect(service.cancel(7, 'a')).toBe(true)
    expect(await result).toEqual({ success: false, code: 'CANCELLED' })
    expect(service.getActiveCount(7)).toBe(0)
    expect(service.getInFlightCount(7)).toBe(1)
    finish?.('late')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.getInFlightCount(7)).toBe(0)
  })
  describe('1. 基础功能与成功路径', () => {
    test('Given 合法输入与允许的模型 When complete 正常返回 Then 返回成功结果并清理活跃记录', async () => {
      let passedSignal: AbortSignal | null = null
      const service = createPromptEnhancementService({
        isModelAllowed: (channelId, modelId) => channelId === 'chan-1' && modelId === 'claude-3-7-sonnet',
        complete: async ({ channelId, modelId, draft, signal }) => {
          passedSignal = signal
          return `Optimized [${channelId}/${modelId}]: ${draft}`
        },
      })

      const promise = service.enhance(100, {
        requestId: 'req-success-1',
        channelId: 'chan-1',
        modelId: 'claude-3-7-sonnet',
        draft: '帮我写一个快速排序',
      })

      expect(service.getActiveCount()).toBe(1)
      expect(service.getActiveCount(100)).toBe(1)

      const result = await promise

      expect(result).toEqual({
        success: true,
        text: 'Optimized [chan-1/claude-3-7-sonnet]: 帮我写一个快速排序',
      })
      expect(passedSignal).not.toBeNull()
      expect((passedSignal as AbortSignal | null)?.aborted).toBe(false)
      // 请求完成后活跃状态及时清理
      expect(service.getActiveCount()).toBe(0)
      expect(service.getActiveCount(100)).toBe(0)
    })

    test('Given 异步 isModelAllowed When 返回 true Then 正确进入 complete', async () => {
      const service = new PromptEnhancementService({
        isModelAllowed: async () => {
          await new Promise((r) => setTimeout(r, 10))
          return true
        },
        complete: async () => 'async model allowed success',
      })

      const res = await service.enhance(1, {
        requestId: 'req-async-allow',
        channelId: 'c1',
        modelId: 'm1',
        draft: 'hello',
      })

      expect(res).toEqual({
        success: true,
        text: 'async model allowed success',
      })
      expect(service.getActiveCount()).toBe(0)
    })
  })

  describe('2. 输入校验边界与参数保护', () => {
    const defaultDeps = {
      isModelAllowed: () => true,
      complete: async () => 'ok',
    }

    test('Given 无效 ownerId When 调用 enhance Then 返回 INVALID_INPUT 且不触发下游', async () => {
      let called = false
      const service = createPromptEnhancementService({
        isModelAllowed: () => {
          called = true
          return true
        },
        complete: async () => 'ok',
      })

      // @ts-expect-error 测试非数字 ownerId
      expect(await service.enhance('invalid', {
        requestId: 'r1',
        channelId: 'c1',
        modelId: 'm1',
        draft: 'draft',
      })).toEqual({ success: false, code: 'INVALID_INPUT' })

      // 测试 NaN
      expect(await service.enhance(Number.NaN, {
        requestId: 'r1',
        channelId: 'c1',
        modelId: 'm1',
        draft: 'draft',
      })).toEqual({ success: false, code: 'INVALID_INPUT' })

      // 测试 Infinity
      expect(await service.enhance(Number.POSITIVE_INFINITY, {
        requestId: 'r1',
        channelId: 'c1',
        modelId: 'm1',
        draft: 'draft',
      })).toEqual({ success: false, code: 'INVALID_INPUT' })

      expect(called).toBe(false)
      expect(service.getActiveCount()).toBe(0)
    })

    test('Given input 为空或非对象 When 调用 enhance Then 返回 INVALID_INPUT', async () => {
      const service = createPromptEnhancementService(defaultDeps)

      // @ts-expect-error 测试 null input
      expect(await service.enhance(1, null)).toEqual({ success: false, code: 'INVALID_INPUT' })
      // @ts-expect-error 测试 undefined input
      expect(await service.enhance(1, undefined)).toEqual({ success: false, code: 'INVALID_INPUT' })
      // @ts-expect-error 测试非对象 input
      expect(await service.enhance(1, 'string-input')).toEqual({ success: false, code: 'INVALID_INPUT' })
    })

    test('Given ID 校验（requestId, channelId, modelId）为空、仅空白或超长 When 调用 enhance Then 严格拒绝', async () => {
      const service = createPromptEnhancementService(defaultDeps)
      const validBase = {
        requestId: 'req-1',
        channelId: 'chan-1',
        modelId: 'model-1',
        draft: 'valid draft',
      }

      // 1. 空或纯空白
      expect(await service.enhance(1, { ...validBase, requestId: '' })).toEqual({ success: false, code: 'INVALID_INPUT' })
      expect(await service.enhance(1, { ...validBase, requestId: '   ' })).toEqual({ success: false, code: 'INVALID_INPUT' })
      expect(await service.enhance(1, { ...validBase, channelId: '' })).toEqual({ success: false, code: 'INVALID_INPUT' })
      expect(await service.enhance(1, { ...validBase, channelId: '  \t ' })).toEqual({ success: false, code: 'INVALID_INPUT' })
      expect(await service.enhance(1, { ...validBase, modelId: '' })).toEqual({ success: false, code: 'INVALID_INPUT' })
      expect(await service.enhance(1, { ...validBase, modelId: ' \n ' })).toEqual({ success: false, code: 'INVALID_INPUT' })

      // 2. 超长 (> 256)
      const id256 = 'a'.repeat(MAX_ID_LENGTH)
      const id257 = 'a'.repeat(MAX_ID_LENGTH + 1)

      // 刚好 256 字符合法
      expect(await service.enhance(1, { ...validBase, requestId: id256 })).toEqual({ success: true, text: 'ok' })
      expect(await service.enhance(1, { ...validBase, channelId: id256 })).toEqual({ success: true, text: 'ok' })
      expect(await service.enhance(1, { ...validBase, modelId: id256 })).toEqual({ success: true, text: 'ok' })

      // 257 字符被拒绝
      expect(await service.enhance(1, { ...validBase, requestId: id257 })).toEqual({ success: false, code: 'INVALID_INPUT' })
      expect(await service.enhance(1, { ...validBase, channelId: id257 })).toEqual({ success: false, code: 'INVALID_INPUT' })
      expect(await service.enhance(1, { ...validBase, modelId: id257 })).toEqual({ success: false, code: 'INVALID_INPUT' })
    })

    test('Given draft 为空、空白或超过 12000 字符 When 调用 enhance Then 严格校验', async () => {
      const service = createPromptEnhancementService(defaultDeps)
      const validBase = {
        requestId: 'req-draft-test',
        channelId: 'chan-1',
        modelId: 'model-1',
      }

      // 空白 draft
      expect(await service.enhance(1, { ...validBase, draft: '' })).toEqual({ success: false, code: 'INVALID_INPUT' })
      expect(await service.enhance(1, { ...validBase, draft: '   \n\r\t ' })).toEqual({ success: false, code: 'INVALID_INPUT' })

      // 恰好 12000 字符允许
      const draft12000 = 'x'.repeat(MAX_DRAFT_LENGTH)
      expect(await service.enhance(1, { ...validBase, draft: draft12000 })).toEqual({ success: true, text: 'ok' })

      // 12001 字符拒绝
      const draft12001 = 'x'.repeat(MAX_DRAFT_LENGTH + 1)
      expect(await service.enhance(1, { ...validBase, draft: draft12001 })).toEqual({ success: false, code: 'INVALID_INPUT' })
    })
  })

  describe('3. 模型权限检查 (isModelAllowed)', () => {
    test('Given 模型未启用或不属于该渠道 When isModelAllowed 返回 false Then 返回 MODEL_NOT_ALLOWED 且不调用 complete', async () => {
      let completeCalled = false
      const service = createPromptEnhancementService({
        isModelAllowed: (chan, mod) => chan === 'chan-a' && mod === 'model-a',
        complete: async () => {
          completeCalled = true
          return 'should not be called'
        },
      })

      const res = await service.enhance(1, {
        requestId: 'req-disallowed',
        channelId: 'chan-b',
        modelId: 'model-a',
        draft: 'some draft',
      })

      expect(res).toEqual({ success: false, code: 'MODEL_NOT_ALLOWED' })
      expect(completeCalled).toBe(false)
      expect(service.getActiveCount()).toBe(0)
    })

    test('Given isModelAllowed 抛出异常 When 调用 enhance Then 安全捕获并返回 MODEL_NOT_ALLOWED', async () => {
      const service = createPromptEnhancementService({
        isModelAllowed: () => {
          throw new Error('Database connection failed')
        },
        complete: async () => 'ok',
      })

      const res = await service.enhance(1, {
        requestId: 'req-error-model',
        channelId: 'c1',
        modelId: 'm1',
        draft: 'draft',
      })

      expect(res).toEqual({ success: false, code: 'MODEL_NOT_ALLOWED' })
      expect(service.getActiveCount()).toBe(0)
    })
  })

  describe('4. 重复请求拦截与完成后再次请求', () => {
    test('Given 同一 ownerId 下存在未完成的同名 requestId When 再次发起 Then 拒绝重复请求', async () => {
      let completeResolver: (val: string) => void = () => {}
      const service = createPromptEnhancementService({
        isModelAllowed: () => true,
        complete: () => new Promise((resolve) => {
          completeResolver = resolve
        }),
      })

      // 启动第一个请求（进入 pending 状态）
      const firstPromise = service.enhance(42, {
        requestId: 'req-concurrent-dup',
        channelId: 'c1',
        modelId: 'm1',
        draft: 'first draft',
      })

      expect(service.getActiveCount(42)).toBe(1)

      // 同一 ownerId, 同一 requestId 发起并发请求
      const secondResult = await service.enhance(42, {
        requestId: 'req-concurrent-dup',
        channelId: 'c1',
        modelId: 'm1',
        draft: 'second draft',
      })

      expect(secondResult).toEqual({ success: false, code: 'DUPLICATE_REQUEST' })

      // 完成第一个请求
      completeResolver('first resolved')
      const firstResult = await firstPromise
      expect(firstResult).toEqual({ success: true, text: 'first resolved' })
      expect(service.getActiveCount(42)).toBe(0)

      // 此时上一个请求已结束，使用相同 requestId 再次发起，应当成功
      const thirdPromise = service.enhance(42, {
        requestId: 'req-concurrent-dup',
        channelId: 'c1',
        modelId: 'm1',
        draft: 'third draft',
      })
      completeResolver('third resolved')
      const thirdResult = await thirdPromise
      expect(thirdResult).toEqual({ success: true, text: 'third resolved' })
      expect(service.getActiveCount(42)).toBe(0)
    })
  })

  describe('5. 跨 owner 隔离与取消 (cancel & cancelOwner)', () => {
    test('Given 不同 ownerId 使用相同 requestId When 并发运行 Then 互相隔离且独立成功', async () => {
      let resolveOwner1: (v: string) => void = () => {}
      let resolveOwner2: (v: string) => void = () => {}

      const service = createPromptEnhancementService({
        isModelAllowed: () => true,
        complete: ({ draft }) => {
          return new Promise((resolve) => {
            if (draft === 'from owner 1') resolveOwner1 = resolve
            if (draft === 'from owner 2') resolveOwner2 = resolve
          })
        },
      })

      const reqInput1 = { requestId: 'shared-req-id', channelId: 'c1', modelId: 'm1', draft: 'from owner 1' }
      const reqInput2 = { requestId: 'shared-req-id', channelId: 'c1', modelId: 'm1', draft: 'from owner 2' }

      const promise1 = service.enhance(10, reqInput1)
      const promise2 = service.enhance(20, reqInput2)

      expect(service.getActiveCount()).toBe(2)
      expect(service.getActiveCount(10)).toBe(1)
      expect(service.getActiveCount(20)).toBe(1)

      resolveOwner1('resp 1')
      resolveOwner2('resp 2')

      const [res1, res2] = await Promise.all([promise1, promise2])
      expect(res1).toEqual({ success: true, text: 'resp 1' })
      expect(res2).toEqual({ success: true, text: 'resp 2' })
      expect(service.getActiveCount()).toBe(0)
    })

    test('Given 同名 requestId 在多个 owner 中运行 When cancel(owner1, requestId) Then 仅取消 owner1，不影响 owner2', async () => {
      let signal1: AbortSignal | null = null
      let signal2: AbortSignal | null = null
      let resolveOwner2: (v: string) => void = () => {}

      const service = createPromptEnhancementService({
        isModelAllowed: () => true,
        complete: ({ draft, signal }) => {
          if (draft === 'owner-1') {
            signal1 = signal
            return new Promise(() => {}) // 挂起
          }
          signal2 = signal
          return new Promise((resolve) => {
            resolveOwner2 = resolve
          })
        },
      })

      const p1 = service.enhance(1, { requestId: 'same-id', channelId: 'c', modelId: 'm', draft: 'owner-1' })
      const p2 = service.enhance(2, { requestId: 'same-id', channelId: 'c', modelId: 'm', draft: 'owner-2' })

      expect(service.getActiveCount()).toBe(2)

      // 取消 owner 1
      const cancelled = service.cancel(1, 'same-id')
      expect(cancelled).toBe(true)

      const res1 = await p1
      expect(res1).toEqual({ success: false, code: 'CANCELLED' })
      expect((signal1 as AbortSignal | null)?.aborted).toBe(true)
      expect(service.getActiveCount(1)).toBe(0)
      expect(service.getActiveCount(2)).toBe(1)

      // 再次取消已取消的返回 false
      expect(service.cancel(1, 'same-id')).toBe(false)
      // 取消不存在的 owner 返回 false
      expect(service.cancel(999, 'same-id')).toBe(false)

      // owner 2 依然健在并可正常成功
      resolveOwner2!('owner 2 finished')
      const res2 = await p2
      expect(res2).toEqual({ success: true, text: 'owner 2 finished' })
      expect((signal2 as AbortSignal | null)?.aborted).toBe(false)
      expect(service.getActiveCount()).toBe(0)
    })

    test('Given owner 下存在多个请求 When 调用 cancelOwner(ownerId) Then 批量取消该 owner 的全部请求并释放', async () => {
      const service = createPromptEnhancementService({
        isModelAllowed: () => true,
        complete: () => new Promise(() => {}), // 全部挂起
      })

      const p1 = service.enhance(1, { requestId: 'r1', channelId: 'c', modelId: 'm', draft: 'd1' })
      const p2 = service.enhance(1, { requestId: 'r2', channelId: 'c', modelId: 'm', draft: 'd2' })
      const p3 = service.enhance(2, { requestId: 'r3', channelId: 'c', modelId: 'm', draft: 'd3' })

      expect(service.getActiveCount()).toBe(3)
      expect(service.getActiveCount(1)).toBe(2)
      expect(service.getActiveCount(2)).toBe(1)

      const cancelledCount = service.cancelOwner(1)
      expect(cancelledCount).toBe(2)

      const [res1, res2] = await Promise.all([p1, p2])
      expect(res1).toEqual({ success: false, code: 'CANCELLED' })
      expect(res2).toEqual({ success: false, code: 'CANCELLED' })

      expect(service.getActiveCount(1)).toBe(0)
      expect(service.getActiveCount(2)).toBe(1)

      // 不存在的 owner 调用返回 0
      expect(service.cancelOwner(999)).toBe(0)

      // 清理 owner 2
      service.cancelOwner(2)
      await p3
      expect(service.getActiveCount()).toBe(0)
    })
  })

  describe('6. 超时处理 (timeoutMs)', () => {
    test('Given 注入自定义 timeoutMs When 耗时超出 Then 立即触发超时、中止 signal 并释放 Map', async () => {
      let signalPassed: AbortSignal | null = null
      const service = createPromptEnhancementService(
        {
          isModelAllowed: () => true,
          complete: ({ signal }) => {
            signalPassed = signal
            return new Promise((resolve) => {
              setTimeout(() => resolve('too late'), 150)
            })
          },
        },
        { timeoutMs: 30 },
      )

      const startTime = Date.now()
      const res = await service.enhance(1, {
        requestId: 'req-timeout',
        channelId: 'c',
        modelId: 'm',
        draft: 'draft text',
      })
      const elapsed = Date.now() - startTime

      expect(res).toEqual({ success: false, code: 'TIMEOUT' })
      expect((signalPassed as AbortSignal | null)?.aborted).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(25)
      expect(elapsed).toBeLessThan(120)
      expect(service.getActiveCount()).toBe(0)
    })
  })

  describe('7. complete 抛错与敏感信息脱敏', () => {
    test('Given complete 抛出包含凭据/内部详情的错误 When 捕获 Then 绝不透出原始错误与 draft 并返回 PROVIDER_ERROR', async () => {
      const sensitiveKey = 'FAKE_OPENAI_TEST_KEY_999'
      const privateDraft = '公司绝密项目战略方案内容'

      const service = createPromptEnhancementService({
        isModelAllowed: () => true,
        complete: async () => {
          throw new Error(`Provider HTTP 401 Unauthorized: Authorization Bearer ${sensitiveKey} for prompt ${privateDraft}`)
        },
      })

      const res = await service.enhance(1, {
        requestId: 'req-leak-test',
        channelId: 'c',
        modelId: 'm',
        draft: privateDraft,
      })

      expect(res.success).toBe(false)
      expect(res).toEqual({ success: false, code: 'PROVIDER_ERROR' })

      // 验证序列化字符串中绝不包含凭据或草稿
      const serialized = JSON.stringify(res)
      expect(serialized).not.toContain(sensitiveKey)
      expect(serialized).not.toContain(privateDraft)
      expect(serialized).not.toContain('401')
      expect(serialized).not.toContain('Unauthorized')

      expect(service.getActiveCount()).toBe(0)
    })

    test('Given complete 返回非字符串类型 When 执行 Then 安全返回 PROVIDER_ERROR', async () => {
      const service = createPromptEnhancementService({
        isModelAllowed: () => true,
        // @ts-expect-error 模拟非法返回值
        complete: async () => null,
      })

      const res = await service.enhance(1, {
        requestId: 'req-non-string',
        channelId: 'c',
        modelId: 'm',
        draft: 'some draft',
      })

      expect(res).toEqual({ success: false, code: 'PROVIDER_ERROR' })
      expect(service.getActiveCount()).toBe(0)
    })
  })

  describe('8. 忽略 AbortSignal 的防悬挂保证 (终结 Promise & 释放 Map)', () => {
    test('Given complete 忽略 signal 永不 resolve When 超时到达 Then 立即终结 Promise 且 Map 立即释放', async () => {
      // 故意创建一个既不监听 signal 也不 resolve/reject 的 Promise
      let neverResolvedPromiseCreated = false
      const service = createPromptEnhancementService(
        {
          isModelAllowed: () => true,
          complete: () => {
            neverResolvedPromiseCreated = true
            return new Promise<string>(() => {
              // 模拟挂死
            })
          },
        },
        { timeoutMs: 35 },
      )

      const start = Date.now()
      const res = await service.enhance(888, {
        requestId: 'req-hanging-timeout',
        channelId: 'c',
        modelId: 'm',
        draft: 'hanging draft',
      })
      const duration = Date.now() - start

      expect(neverResolvedPromiseCreated).toBe(true)
      expect(res).toEqual({ success: false, code: 'TIMEOUT' })
      expect(duration).toBeGreaterThanOrEqual(30)
      expect(duration).toBeLessThan(100)

      // 关键断言：Map 必须立即释放，绝不能无限等待底层 complete
      expect(service.getActiveCount()).toBe(0)
      expect(service.getActiveCount(888)).toBe(0)
    })

    test('Given complete 忽略 signal 永不 resolve When 外部调用 cancel Then 立即终结 Promise 且 Map 立即释放', async () => {
      const service = createPromptEnhancementService({
        isModelAllowed: () => true,
        complete: () => new Promise<string>(() => {
          // 故意不响应 signal，永不返回
        }),
      })

      const p = service.enhance(999, {
        requestId: 'req-hanging-cancel',
        channelId: 'c',
        modelId: 'm',
        draft: 'hanging cancel draft',
      })

      expect(service.getActiveCount(999)).toBe(1)

      // 立即取消
      const didCancel = service.cancel(999, 'req-hanging-cancel')
      expect(didCancel).toBe(true)

      const res = await p
      expect(res).toEqual({ success: false, code: 'CANCELLED' })

      // 关键断言：即使 complete 挂死，Promise 已决议且 Map 已彻底释放
      expect(service.getActiveCount()).toBe(0)
      expect(service.getActiveCount(999)).toBe(0)
    })
  })

  describe('9. 实例销毁 (destroy)', () => {
    test('Given 服务正在运行多个请求 When destroy 调用 Then 终结所有请求并拒绝后续请求', async () => {
      let aborted1 = false
      let aborted2 = false

      const service = createPromptEnhancementService({
        isModelAllowed: () => true,
        complete: ({ signal }) => {
          signal.addEventListener('abort', () => {
            if (signal.aborted) {
              if (!aborted1) aborted1 = true
              else aborted2 = true
            }
          })
          return new Promise(() => {})
        },
      })

      const p1 = service.enhance(1, { requestId: 'r1', channelId: 'c', modelId: 'm', draft: 'd1' })
      const p2 = service.enhance(2, { requestId: 'r2', channelId: 'c', modelId: 'm', draft: 'd2' })

      expect(service.getActiveCount()).toBe(2)

      service.destroy()

      const [res1, res2] = await Promise.all([p1, p2])
      expect(res1).toEqual({ success: false, code: 'DESTROYED' })
      expect(res2).toEqual({ success: false, code: 'DESTROYED' })
      expect(aborted1).toBe(true)
      expect(service.getActiveCount()).toBe(0)

      // 销毁后发起新请求直接返回 DESTROYED
      const resAfter = await service.enhance(1, { requestId: 'r3', channelId: 'c', modelId: 'm', draft: 'd3' })
      expect(resAfter).toEqual({ success: false, code: 'DESTROYED' })
    })
  })
})
