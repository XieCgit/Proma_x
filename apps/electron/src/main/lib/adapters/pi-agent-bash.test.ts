import { describe, expect, test } from 'bun:test'
import { buildWslBashArgs, windowsPathToWslPath } from './pi-agent-adapter'

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given an empty independent CLI override When building WSL command Then clears inherited CLI and sets the dev profile', () => {
    const args = buildWslBashArgs(
      {}, 'C:\\project', 'pwd', { PROMA_CLI: '', PROMA_DEV: '1' },
    )
    expect(args.at(-1)).toBe("unset PROMA_CLI\nexport PROMA_DEV='1'\npwd")
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })

})
