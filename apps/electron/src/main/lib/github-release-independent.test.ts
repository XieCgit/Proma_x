import { afterEach, describe, expect, test } from 'bun:test'
import { getLatestRelease, getReleaseByTag, listReleases } from './github-release-service'

describe('独立版未配置发布源', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  test('所有 release 查询均不请求上游，并返回空结果', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; throw new Error('unexpected network') }) as unknown as typeof fetch
    expect(await getLatestRelease()).toBeNull()
    expect(await getReleaseByTag('v1.0.0')).toBeNull()
    expect(await listReleases()).toEqual([])
    expect(called).toBe(false)
  })
})
