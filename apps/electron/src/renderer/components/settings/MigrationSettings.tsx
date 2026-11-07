import * as React from 'react'
import { Copy, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import { SettingsSection } from './primitives'
import { copyTextToClipboard } from '@/lib/clipboard'

function getArchiveMigrationPrompt(configDirName: string): string {
  return `请帮我创建一个可迁移的 Proma Agent Next 独立版数据压缩包。

【重要安全规则】
当前应用为独立版 Proma Agent Next，本地数据目录为 ~/${configDirName}。
绝对禁止读取、修改、移动或覆盖原版 Proma 数据目录 ~/.proma！待压缩的数据源必须严格限定在 ~/${configDirName}，ZIP 输出位置由我明确确认。

请按以下步骤处理：

1. 先确认当前独立版 Proma 数据文件夹的位置（~/${configDirName}）、计划生成的 ZIP 路径，以及压缩包是否可能包含会话记录、工作区配置和本地文件；严禁将原版 ~/.proma 纳入处理范围。
2. 在开始压缩前向我展示扫描到的目录范围与计划输出路径，并征得我的明确确认；操作过程中不要删除、移动或修改原始数据文件夹。
3. 经我确认后，将完整的 ~/${configDirName} 数据文件夹压缩为一个 ZIP 文件，并告诉我生成路径和文件大小。
4. 提醒我将 ZIP 通过可信方式传输到新设备，并在新设备的 Proma Agent Next 对话中附上该 ZIP，执行恢复、项目路径分配和索引重建。
5. 不要尝试导出系统钥匙串、OAuth 登录或其他系统级凭据；这些内容需要在新设备上重新登录或配置。`
}

function getRestoreMigrationPrompt(configDirName: string): string {
  return `我正在恢复来自另一台设备的 Proma Agent Next 独立版数据，并已附上数据文件夹（~/${configDirName}）的 ZIP 压缩包。

【重要安全规则】
当前应用为独立版 Proma Agent Next，目标数据目录为 ~/${configDirName}。
严禁将原版 ~/.proma 作为目标，严禁写入、修改或覆盖原版 ~/.proma 中的任何文件！

请按以下步骤处理：

1. 先检查 ZIP 的内容，并明确说明将要写入的此设备独立版 Proma 数据目录（~/${configDirName}）以及可能覆盖的文件列表；严禁将原版 ~/.proma 作为目标。
2. 在执行任何覆盖前，必须向我展示变更范围并征得我的明确确认；在取得确认后，必须先为当前现有的 ~/${configDirName} 数据创建带时间戳的可恢复安全备份。
3. 将压缩包解压到此设备的独立版 Proma 数据目录（~/${configDirName}），按当前版本的数据结构完成必要迁移，绝不影响原版 ~/.proma。
4. 为每个恢复的工作区核对对应的本地项目目录；旧设备路径不可用时，询问我如何重新分配或跳过。
5. 重建会话、工作区和本地文件索引，检查恢复的数据是否能正常读取。
6. 完成后说明恢复的会话、工作区和需要重新绑定的本地项目；不要尝试恢复系统钥匙串、API Key 或 OAuth 登录，缺失的凭据请提示我重新配置。`
}

export function MigrationSettings(): React.ReactElement {
  const [configDirName, setConfigDirName] = React.useState<string | null>(null)
  React.useEffect(() => {
    let mounted = true
    window.electronAPI.getIndependentConfigDirName().then(
      (name) => { if (mounted) setConfigDirName(name) },
      () => { if (mounted) toast.error('无法确定独立版数据目录') },
    )
    return () => { mounted = false }
  }, [])

  const archiveMigrationPrompt = React.useMemo(
    () => configDirName ? getArchiveMigrationPrompt(configDirName) : '',
    [configDirName],
  )

  const restoreMigrationPrompt = React.useMemo(
    () => configDirName ? getRestoreMigrationPrompt(configDirName) : '',
    [configDirName],
  )

  const handleOpenDataFolder = async (): Promise<void> => {
    try {
      await window.electronAPI.openMigrationDataFolder()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开数据文件夹')
    }
  }

  const handleCopyPrompt = (prompt: string, successMessage: string): void => {
    void copyTextToClipboard(prompt).then(
      () => toast.success(successMessage),
      () => toast.error('复制失败，请手动复制提示词'),
    )
  }

  const handleCopyArchivePrompt = (): void => {
    if (configDirName) handleCopyPrompt(archiveMigrationPrompt, '创建压缩包提示词已复制到剪贴板')
  }

  const handleCopyRestorePrompt = (): void => {
    if (configDirName) handleCopyPrompt(restoreMigrationPrompt, '恢复数据提示词已复制到剪贴板')
  }

  if (!configDirName) return <div className="text-sm text-muted-foreground">正在确认独立版数据目录…</div>

  return (
    <div className="space-y-8">
      <SettingsSection
        title="迁移原理"
        description={`Proma Agent Next 独立版的本地数据存放在 ~/${configDirName} 文件夹（默认不使用原版 ~/.proma）。迁移时先压缩该文件夹，再在新设备上由 Proma Agent Next 解压、分配项目路径并重建索引。`}
      >
        <ol className="space-y-3 text-sm leading-6 text-muted-foreground">
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">1</span>
            <span>在当前设备将完整的 ~/{configDirName} 数据文件夹压缩为 ZIP，压缩前需确认范围，原始数据保持不变，严禁触碰原版 ~/.proma。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">2</span>
            <span>将 ZIP 通过可信方式传输到新设备，并附到新设备 Proma Agent Next 的对话中。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">3</span>
            <span>新设备上的 Proma Agent Next 解压到独立目录 ~/{configDirName}（覆盖前征得确认并创建安全备份），重新分配本地项目目录，并重建会话、工作区和文件索引。</span>
          </li>
        </ol>
      </SettingsSection>

      <SettingsSection
        title="当前设备：创建迁移压缩包"
        description={`先打开独立版数据文件夹（~/${configDirName}）；随后可将提示词粘贴到任意 Proma Agent Next 对话，由 Agent 在确认后协助创建 ZIP。`}
      >
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void handleOpenDataFolder()}
            className="flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.96]"
          >
            <FolderOpen size={16} />
            打开数据文件夹
          </button>
          <button
            onClick={handleCopyArchivePrompt}
            className="flex min-h-10 items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/60 active:scale-[0.96]"
          >
            <Copy size={16} />
            复制创建压缩包提示词
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="新设备：恢复 Proma 数据"
        description={`在新设备 Proma Agent Next 对话中附上 ZIP，再粘贴以下提示词恢复到独立版目录（~/${configDirName}），严禁覆盖原版 ~/.proma。`}
      >
        <div className="relative rounded-lg border border-border/60 bg-muted/30 p-4 pr-14">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-muted-foreground">{restoreMigrationPrompt}</pre>
          <button
            aria-label="复制恢复数据提示词"
            title="复制恢复数据提示词"
            onClick={handleCopyRestorePrompt}
            className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground active:scale-[0.96]"
          >
            <Copy size={16} />
          </button>
        </div>
      </SettingsSection>

      <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-200">
        数据文件夹包含独立版的会话记录、文件和配置，迁移的数据源与恢复目标均为独立版目录（~/{configDirName}），严禁覆盖或修改原版 ~/.proma。请仅通过可信渠道传输并妥善保管压缩包。系统钥匙串中的 API Key 和登录凭据不会随文件夹复制，迁移后可能需要重新登录或配置。
      </div>
    </div>
  )
}
