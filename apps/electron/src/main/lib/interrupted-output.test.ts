import { describe, expect, test } from 'bun:test'
import type { AgentAssistantDelta } from '@proma/shared'
import {
  DEFAULT_MAX_BYTES_PER_UUID,
  DEFAULT_MAX_CONTENT_INDEX,
  DEFAULT_MAX_UUIDS,
  InterruptedOutputBuffer,
  createInterruptedOutputBuffer,
} from './interrupted-output'

describe('InterruptedOutputBuffer', () => {
  test('无文本（空内容与纯空白）不产生消息', () => {
    const buffer = createInterruptedOutputBuffer()

    // 没有任何 delta 时 drain
    expect(buffer.drain()).toEqual([])

    // 仅有 text_start 但无内容
    buffer.accept({
      uuid: 'msg-1',
      session_id: 'sess-1',
      delta: { type: 'text_start', contentIndex: 0 },
    })
    expect(buffer.drain()).toEqual([])

    // 纯空白字符（空格、换行、制表符）
    buffer.accept({
      uuid: 'msg-2',
      session_id: 'sess-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: '   \n\t  ' },
    })
    expect(buffer.drain()).toEqual([])

    // 多个 index 全是空白
    buffer.accept({
      uuid: 'msg-3',
      session_id: 'sess-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: '   ' },
    })
    buffer.accept({
      uuid: 'msg-3',
      session_id: 'sess-1',
      delta: { type: 'text_delta', contentIndex: 1, delta: '\n\n' },
    })
    expect(buffer.drain()).toEqual([])
  })

  test('分片流式合并 (text_start + text_delta chunks)', () => {
    const buffer = new InterruptedOutputBuffer()

    buffer.accept({
      uuid: 'msg-chunk',
      session_id: 'sess-abc',
      delta: { type: 'text_start', contentIndex: 0 },
    })
    buffer.accept({
      uuid: 'msg-chunk',
      session_id: 'sess-abc',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
    })
    buffer.accept({
      uuid: 'msg-chunk',
      session_id: 'sess-abc',
      delta: { type: 'text_delta', contentIndex: 0, delta: ', ' },
    })
    buffer.accept({
      uuid: 'msg-chunk',
      session_id: 'sess-abc',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'world!' },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    const msg = drained[0]!

    expect(msg.type).toBe('assistant')
    expect(msg.uuid).toBe('msg-chunk')
    expect(msg.session_id).toBe('sess-abc')
    expect(msg.parent_tool_use_id).toBeNull()
    expect(msg._promaInterrupted).toBe(true)
    expect(msg._promaInterruptedTruncated).toBe(false)
    expect(msg.message.content).toEqual([{ type: 'text', text: 'Hello, world!' }])
  })

  test('截断不会保留孤立的 UTF-16 高代理字符', () => {
    const buffer = createInterruptedOutputBuffer({ maxBytesPerUuid: 4 })
    buffer.accept({ uuid: 'u', delta: { type: 'text_delta', contentIndex: 0, delta: 'a😀' } })
    const [message] = buffer.drain()
    expect(message?._promaInterruptedTruncated).toBe(true)
    expect(message?.message.content).toEqual([{ type: 'text', text: 'a' }])
  })

  test('text_end 覆盖替换累加内容而非叠加 delta', () => {
    const buffer = createInterruptedOutputBuffer()

    // 先发送部分可能不一致的增量分片
    buffer.accept({
      uuid: 'msg-overwrite',
      session_id: 'sess-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'draft draft draft' },
    })

    // text_end 发送最终完整内容
    buffer.accept({
      uuid: 'msg-overwrite',
      session_id: 'sess-1',
      delta: { type: 'text_end', contentIndex: 0, content: 'Final polished statement.' },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.message.content).toEqual([
      { type: 'text', text: 'Final polished statement.' },
    ])
  })

  test('按 UUID 隔离并按 contentIndex 严格升序排序', () => {
    const buffer = createInterruptedOutputBuffer()

    // 乱序发送不同的 contentIndex
    buffer.accept({
      uuid: 'msg-multi-index',
      session_id: 'sess-1',
      delta: { type: 'text_delta', contentIndex: 3, delta: 'Fourth paragraph.' },
    })
    buffer.accept({
      uuid: 'msg-multi-index',
      session_id: 'sess-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'First paragraph.' },
    })
    buffer.accept({
      uuid: 'msg-multi-index',
      session_id: 'sess-1',
      delta: { type: 'text_delta', contentIndex: 1, delta: 'Second paragraph.' },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.message.content).toEqual([
      { type: 'text', text: 'First paragraph.' },
      { type: 'text', text: 'Second paragraph.' },
      { type: 'text', text: 'Fourth paragraph.' },
    ])
  })

  test('多个 UUID 之间互相独立并保持顺序', () => {
    const buffer = createInterruptedOutputBuffer()

    buffer.accept({
      uuid: 'uuid-1',
      session_id: 's-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'Output for 1' },
    })
    buffer.accept({
      uuid: 'uuid-2',
      session_id: 's-2',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'Output for 2' },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(2)
    expect(drained[0]!.uuid).toBe('uuid-1')
    expect(drained[0]!.session_id).toBe('s-1')
    expect(drained[0]!.message.content).toEqual([{ type: 'text', text: 'Output for 1' }])

    expect(drained[1]!.uuid).toBe('uuid-2')
    expect(drained[1]!.session_id).toBe('s-2')
    expect(drained[1]!.message.content).toEqual([{ type: 'text', text: 'Output for 2' }])
  })

  test('start 标记同 UUID 新一轮/重试开始，清除旧缓存避免重复', () => {
    const buffer = createInterruptedOutputBuffer()

    // 第一轮旧数据
    buffer.accept({
      uuid: 'uuid-retry',
      session_id: 's-old',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'First try that will fail' },
    })

    // 收到 start 重置信号
    buffer.accept({
      uuid: 'uuid-retry',
      session_id: 's-new',
      delta: { type: 'start' },
    })

    // 紧接着在同一 UUID 开始新一轮
    buffer.accept({
      uuid: 'uuid-retry',
      session_id: 's-new',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'Clean retry output' },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.uuid).toBe('uuid-retry')
    expect(drained[0]!.session_id).toBe('s-new')
    expect(drained[0]!.message.content).toEqual([{ type: 'text', text: 'Clean retry output' }])
  })

  test('complete(uuid) 正常清除已完成 assistant 消息的缓存', () => {
    const buffer = createInterruptedOutputBuffer()

    buffer.accept({
      uuid: 'uuid-done',
      session_id: 's-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'This run will complete' },
    })
    buffer.accept({
      uuid: 'uuid-interrupted',
      session_id: 's-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'This run was interrupted' },
    })

    // uuid-done 收到完整响应，调用 complete 清理
    buffer.complete('uuid-done')

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.uuid).toBe('uuid-interrupted')
    expect(drained[0]!.message.content).toEqual([
      { type: 'text', text: 'This run was interrupted' },
    ])
  })

  test('thinking 与 toolcall 事件被严格忽略，不被保存', () => {
    const buffer = createInterruptedOutputBuffer()

    // 纯思考和工具事件
    buffer.accept({
      uuid: 'uuid-hidden',
      session_id: 's-1',
      delta: { type: 'thinking_start', contentIndex: 0 },
    })
    buffer.accept({
      uuid: 'uuid-hidden',
      session_id: 's-1',
      delta: { type: 'thinking_delta', contentIndex: 0, delta: 'Confidential reasoning chain' },
    })
    buffer.accept({
      uuid: 'uuid-hidden',
      session_id: 's-1',
      delta: { type: 'thinking_end', contentIndex: 0, content: 'Confidential reasoning complete' },
    })
    buffer.accept({
      uuid: 'uuid-hidden',
      session_id: 's-1',
      delta: {
        type: 'toolcall_start',
        contentIndex: 1,
        toolCall: { id: 'call_99', name: 'bash', arguments: { command: 'cat token.txt' } },
      },
    })
    buffer.accept({
      uuid: 'uuid-hidden',
      session_id: 's-1',
      delta: {
        type: 'toolcall_delta',
        contentIndex: 1,
        delta: '{"command":"cat token.txt"}',
      },
    })
    buffer.accept({
      uuid: 'uuid-hidden',
      session_id: 's-1',
      delta: {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: { id: 'call_99', name: 'bash', arguments: { command: 'cat token.txt' } },
      },
    })

    // 此时没有任何可见文本，drain 应为空
    expect(buffer.drain()).toEqual([])

    // 混合场景：包含 thinking、toolcall 以及可见 text
    buffer.accept({
      uuid: 'uuid-mixed',
      session_id: 's-2',
      delta: { type: 'thinking_delta', contentIndex: 0, delta: 'Private thought' },
    })
    buffer.accept({
      uuid: 'uuid-mixed',
      session_id: 's-2',
      delta: { type: 'text_delta', contentIndex: 1, delta: 'Visible response to user.' },
    })
    buffer.accept({
      uuid: 'uuid-mixed',
      session_id: 's-2',
      delta: {
        type: 'toolcall_start',
        contentIndex: 2,
        toolCall: { id: 'call_1', name: 'read' },
      },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!.message.content).toEqual([
      { type: 'text', text: 'Visible response to user.' },
    ])
  })

  test('大小限制与截断标记 (_promaInterruptedTruncated 不得 silent 截断)', () => {
    // 设置每 UUID 最大 30 字节上限
    const buffer = createInterruptedOutputBuffer({ maxBytesPerUuid: 30 })

    // "Hello, World! " 是 14 字节
    buffer.accept({
      uuid: 'uuid-limit',
      session_id: 's-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'Hello, World! ' },
    })

    // 再加 20 字节 => 总共 34 字节，超过 30 字节上限
    buffer.accept({
      uuid: 'uuid-limit',
      session_id: 's-1',
      delta: { type: 'text_delta', contentIndex: 0, delta: '12345678901234567890' },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    const msg = drained[0]!
    expect(msg._promaInterruptedTruncated).toBe(true)

    const resultText = (msg.message.content[0] as { type: 'text'; text: string }).text
    expect(Buffer.byteLength(resultText, 'utf8')).toBeLessThanOrEqual(30)
    expect(resultText.startsWith('Hello, World! ')).toBe(true)
  })

  test('默认 128KB 上限截断与标志测试', () => {
    const buffer = createInterruptedOutputBuffer()

    // 构造一个 140KB (143,360 字节) 的长字符串
    const largeChunk = 'A'.repeat(140 * 1024)
    buffer.accept({
      uuid: 'uuid-128kb',
      delta: { type: 'text_delta', contentIndex: 0, delta: largeChunk },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    const msg = drained[0]!
    expect(msg._promaInterruptedTruncated).toBe(true)

    const resultText = (msg.message.content[0] as { type: 'text'; text: string }).text
    expect(Buffer.byteLength(resultText, 'utf8')).toBe(128 * 1024)
  })

  test('多字节 UTF-8 字符在截断边界处安全切分，不产生半个字符乱码', () => {
    // 每一个中文字符在 UTF-8 中占 3 字节。"你好世界" 占 12 字节
    // 设置上限为 10 字节，应该只保留前 3 个字 "你好世" (9 字节)，而不是切成 10 字节产生乱码
    const buffer = createInterruptedOutputBuffer({ maxBytesPerUuid: 10 })

    buffer.accept({
      uuid: 'uuid-unicode',
      delta: { type: 'text_delta', contentIndex: 0, delta: '你好世界' },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!._promaInterruptedTruncated).toBe(true)
    const text = (drained[0]!.message.content[0] as { type: 'text'; text: string }).text
    expect(text).toBe('你好世')
    expect(Buffer.byteLength(text, 'utf8')).toBe(9)
  })

  test('text_end 超过大小限制时同样截断并标记 _promaInterruptedTruncated', () => {
    const buffer = createInterruptedOutputBuffer({ maxBytesPerUuid: 20 })

    buffer.accept({
      uuid: 'uuid-end-limit',
      delta: {
        type: 'text_end',
        contentIndex: 0,
        content: 'This text is definitely much longer than 20 bytes!',
      },
    })

    const drained = buffer.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]!._promaInterruptedTruncated).toBe(true)
    const text = (drained[0]!.message.content[0] as { type: 'text'; text: string }).text
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(20)
  })

  test('重复调用 drain() 第一次清空后返回空数组', () => {
    const buffer = createInterruptedOutputBuffer()

    buffer.accept({
      uuid: 'uuid-drain-once',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'Pending text' },
    })

    const firstDrain = buffer.drain()
    expect(firstDrain).toHaveLength(1)
    expect(buffer.size).toBe(0)

    const secondDrain = buffer.drain()
    expect(secondDrain).toEqual([])

    const thirdDrain = buffer.drain()
    expect(thirdDrain).toEqual([])
  })

  test('UUID 数量有界淘汰最旧条目 (maxUuids)', () => {
    const buffer = createInterruptedOutputBuffer({ maxUuids: 3 })

    buffer.accept({ uuid: 'u1', delta: { type: 'text_delta', contentIndex: 0, delta: 'Text 1' } })
    buffer.accept({ uuid: 'u2', delta: { type: 'text_delta', contentIndex: 0, delta: 'Text 2' } })
    buffer.accept({ uuid: 'u3', delta: { type: 'text_delta', contentIndex: 0, delta: 'Text 3' } })

    expect(buffer.size).toBe(3)

    // 放入第四个 UUID，应逐出最旧的 u1
    buffer.accept({ uuid: 'u4', delta: { type: 'text_delta', contentIndex: 0, delta: 'Text 4' } })
    expect(buffer.size).toBe(3)

    const drained = buffer.drain()
    const uuids = drained.map((m) => m.uuid)
    expect(uuids).toEqual(['u2', 'u3', 'u4'])
  })

  test('恶意与畸形输入防御性检查 (不崩溃、不污染原型、不泄露敏感信息)', () => {
    const buffer = createInterruptedOutputBuffer({ maxContentIndex: 50 })

    // 空值与非对象调用
    buffer.accept(null as any)
    buffer.accept(undefined as any)
    buffer.accept({} as any)
    buffer.accept({ uuid: '', delta: { type: 'text_delta', contentIndex: 0, delta: 'a' } } as any)
    buffer.accept({ uuid: '   ', delta: { type: 'text_delta', contentIndex: 0, delta: 'a' } } as any)
    buffer.accept({ uuid: 12345 as any, delta: { type: 'text_delta', contentIndex: 0, delta: 'a' } } as any)

    // 原型属性作为 uuid
    buffer.accept({
      uuid: '__proto__',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'proto text' },
    })
    expect(buffer.size).toBe(1)
    expect(Object.prototype.hasOwnProperty('blocks')).toBe(false)
    buffer.complete('__proto__')
    expect(buffer.size).toBe(0)

    // 非法 delta
    buffer.accept({ uuid: 'u-valid', delta: null as any })
    buffer.accept({ uuid: 'u-valid', delta: undefined as any })
    buffer.accept({ uuid: 'u-valid', delta: { type: 'unknown_type' } as any })
    buffer.accept({ uuid: 'u-valid', delta: { type: 999 } as any })

    // 非法 contentIndex（负数、浮点、NaN、超出上限）
    buffer.accept({
      uuid: 'u-valid',
      delta: { type: 'text_delta', contentIndex: -1, delta: 'bad negative' },
    })
    buffer.accept({
      uuid: 'u-valid',
      delta: { type: 'text_delta', contentIndex: 1.5, delta: 'bad float' },
    })
    buffer.accept({
      uuid: 'u-valid',
      delta: { type: 'text_delta', contentIndex: NaN, delta: 'bad nan' },
    })
    buffer.accept({
      uuid: 'u-valid',
      delta: { type: 'text_delta', contentIndex: Infinity, delta: 'bad inf' },
    })
    buffer.accept({
      uuid: 'u-valid',
      delta: { type: 'text_delta', contentIndex: 99999, delta: 'exceeds maxIndex' },
    })

    // 非法 delta / content 内容（非字符串）
    buffer.accept({
      uuid: 'u-valid',
      delta: { type: 'text_delta', contentIndex: 0, delta: null as any },
    })
    buffer.accept({
      uuid: 'u-valid',
      delta: { type: 'text_delta', contentIndex: 0, delta: 12345 as any },
    })
    buffer.accept({
      uuid: 'u-valid',
      delta: { type: 'text_end', contentIndex: 0, content: undefined as any },
    })

    // 非法 complete
    buffer.complete(null as any)
    buffer.complete(undefined as any)
    buffer.complete('')

    // 验证整个过程没有任何未处理异常，且无效数据不产出有效消息
    expect(buffer.drain()).toEqual([])
  })

  test('默认配置常量暴露符合规范', () => {
    expect(DEFAULT_MAX_BYTES_PER_UUID).toBe(128 * 1024)
    expect(DEFAULT_MAX_UUIDS).toBe(100)
    expect(DEFAULT_MAX_CONTENT_INDEX).toBe(1024)
  })
})
