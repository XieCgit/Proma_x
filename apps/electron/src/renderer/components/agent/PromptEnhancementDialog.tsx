import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { copyTextToClipboard } from '@/lib/clipboard'

interface PromptEnhancementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialDraft: string
  channelId: string | null
  channelLabel: string
  modelId: string | null
}

const ERROR_TEXT: Record<string, string> = {
  INVALID_INPUT: '请输入 1 至 12000 个字符的提示词。',
  MODEL_NOT_ALLOWED: '当前渠道或模型不可用。此功能仅支持普通 API Key 渠道和 HTTPS（本机回环可用 HTTP）；OAuth 订阅及 Antigravity 暂不支持。',
  DUPLICATE_REQUEST: '该请求已在处理，请稍候。',
  BUSY: '正在处理其他增强请求，请稍候。',
  CANCELLED: '请求已取消。',
  TIMEOUT: '请求超时，请重试。',
  PROVIDER_ERROR: '请求失败，请检查渠道、网络及模型配置。',
  DESTROYED: '服务已关闭，请重试。',
}

/** 不直接覆盖编辑器，保留富文本引用与用户在等待期间的新输入。 */
export function PromptEnhancementDialog({
  open, onOpenChange, initialDraft, channelId, channelLabel, modelId,
}: PromptEnhancementDialogProps): React.ReactElement {
  const [draft, setDraft] = React.useState(initialDraft)
  const [result, setResult] = React.useState('')
  const [error, setError] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const activeRequest = React.useRef<string | null>(null)

  const cancel = React.useCallback((): void => {
    const id = activeRequest.current
    activeRequest.current = null
    if (id) void window.electronAPI.cancelPromptEnhancement(id).catch(() => {})
    setRunning(false)
  }, [])

  React.useEffect(() => {
    if (open) {
      setDraft(initialDraft)
      setResult('')
      setError('')
      setRunning(false)
    }
    return () => {
      const id = activeRequest.current
      activeRequest.current = null
      if (id) void window.electronAPI.cancelPromptEnhancement(id).catch(() => {})
    }
  }, [open, initialDraft, channelId, modelId])

  const start = async (): Promise<void> => {
    if (!channelId || !modelId || running || !draft.trim() || draft.length > 12_000) return
    const requestId = crypto.randomUUID()
    activeRequest.current = requestId
    setRunning(true)
    setError('')
    setResult('')
    try {
      const response = await window.electronAPI.enhancePrompt({ requestId, channelId, modelId, draft })
      if (activeRequest.current !== requestId) return
      if (response.success) setResult(response.text)
      else setError(ERROR_TEXT[response.code] ?? '请求失败，请稍后重试。')
    } catch {
      if (activeRequest.current === requestId) setError('请求失败，请稍后重试。')
    } finally {
      if (activeRequest.current === requestId) {
        activeRequest.current = null
        setRunning(false)
      }
    }
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next) cancel()
    onOpenChange(next)
  }

  const copyResult = async (): Promise<void> => {
    try {
      await copyTextToClipboard(result)
      toast.success('增强结果已复制')
    } catch {
      toast.error('复制失败，请手动复制结果')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>增强提示词</DialogTitle>
          <DialogDescription>
            点击“开始增强”后，仅将下面的文本发送到选定渠道（{channelLabel}）的模型（{modelId ?? '未选择'}），可能产生费用；附件不会自动发送。结果不会自动覆盖原草稿。
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-2 text-sm font-medium">
          待增强文本
          <textarea
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setResult(''); setError('') }}
            disabled={running}
            maxLength={12_000}
            rows={5}
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {result && (
          <label className="grid gap-2 text-sm font-medium">
            增强结果
            <textarea
              readOnly value={result} rows={7}
              className="w-full resize-y rounded-md border border-input bg-muted/30 px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </label>
        )}
        <DialogFooter>
          {running ? (
            <Button type="button" variant="outline" onClick={cancel}>取消请求</Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>关闭</Button>
          )}
          {result && <Button type="button" variant="outline" onClick={() => void copyResult()}>复制结果</Button>}
          <Button type="button" onClick={() => void start()} disabled={running || !channelId || !modelId || !draft.trim() || draft.length > 12_000}>
            {running ? '增强中…' : '开始增强'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
