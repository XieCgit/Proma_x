import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const configModulePath = resolve(import.meta.dir, 'config-paths.ts')

function inspectConfigInFreshProcess(home: string, dev: boolean): { directoryName: string; directory: string } {
  const code = `
    const paths = await import(process.env.NEXT_CONFIG_MODULE)
    const directoryName = paths.getConfigDirName()
    const directory = paths.getConfigDir()
    console.log('RESULT:' + JSON.stringify({ directoryName, directory }))
  `
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: import.meta.dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      NEXT_CONFIG_MODULE: configModulePath,
      PROMA_DEV: dev ? '1' : '0',
    },
  })
  expect(result.status).toBe(0)
  const output = result.stdout.split('\n').find((line) => line.startsWith('RESULT:'))
  expect(output).toBeDefined()
  return JSON.parse(output!.slice('RESULT:'.length)) as { directoryName: string; directory: string }
}

describe('独立 Agent 配置隔离', () => {
  test('Given 旧版目录存在 When 解析正式和开发配置 Then 旧目录的哨兵内容保持不变', () => {
    // TMPDIR 由调用方设为新仓库的隔离目录，不涉及用户真实 HOME。
    const home = mkdtempSync(join(tmpdir(), 'next-isolation-'))
    for (const name of ['.proma', '.proma-dev']) {
      mkdirSync(join(home, name), { recursive: true })
      writeFileSync(join(home, name, 'sentinel.txt'), `preserve:${name}`, 'utf8')
    }

    const production = inspectConfigInFreshProcess(home, false)
    const development = inspectConfigInFreshProcess(home, true)

    expect(production.directoryName).toBe('.proma-agent-next')
    expect(production.directory).toBe(join(home, '.proma-agent-next'))
    expect(development.directoryName).toBe('.proma-agent-next-dev')
    expect(development.directory).toBe(join(home, '.proma-agent-next-dev'))
    for (const name of ['.proma', '.proma-dev']) {
      expect(readFileSync(join(home, name, 'sentinel.txt'), 'utf8')).toBe(`preserve:${name}`)
    }
  })
})
