/**
 * SessionUsageBadge — 本会话已保存用量指示器
 *
 * 纯只读展示组件，不改动传入数据、不发网络请求、不读文件、不计算成本。
 * 从 @proma/session-core 导入 summarizeSessionUsage 汇总消息中的已保存用量。
 *
 * 交互与视觉规范：
 * 1. 键盘可访问：复用 Radix Popover 与 Button，支持 Enter/Space 激活、Escape 关闭、Tab 聚焦与焦点回归。
 * 2. 具备明确中文 aria-label，提示当前保存的用量总计或暂无数据状态。
 * 3. Popover 展示：
 *    - 标题：「本会话已保存用量」
 *    - 明细：输入、输出、缓存读取、缓存写入、总计
 *    - 若无 result 记录：展示「暂无已保存用量」
 *    - 若 isIncomplete=true：展示「记录不完整，可能低估」
 */

import * as React from 'react'
import { AlertTriangle, BarChart3 } from 'lucide-react'
import type { SDKMessage } from '@proma/shared'
import { summarizeSessionUsage, type SessionTokenUsage } from '@proma/session-core'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface SessionUsageBadgeProps {
  /** 会话消息列表（只读），由外部传入 */
  messages?: readonly SDKMessage[] | null
  /** 外部容器或 Trigger 自定义样式名 */
  className?: string
  /** 内部按钮自定义样式名 */
  buttonClassName?: string
  /** 弹出位置：top | bottom | left | right */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 对齐方式：start | center | end */
  align?: 'start' | 'center' | 'end'
}

/** 将大数字格式化为简洁易读的字符串（如 1234 → 1.2k） */
function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${tokens}`
}

/** 单行明细键值对 */
interface DetailRowProps {
  label: string
  value: number
  emphasized?: boolean
}

function DetailRow({ label, value, emphasized = false }: DetailRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className={emphasized ? 'font-medium text-foreground' : 'text-muted-foreground'}>
        {label}
      </span>
      <span
        className={cn(
          'tabular-nums',
          emphasized ? 'font-semibold text-foreground' : 'text-foreground/90',
        )}
      >
        {value.toLocaleString()}
      </span>
    </div>
  )
}

export function SessionUsageBadge({
  messages,
  className,
  buttonClassName,
  side = 'top',
  align = 'center',
}: SessionUsageBadgeProps): React.ReactElement {
  const usage: SessionTokenUsage = React.useMemo(() => {
    return summarizeSessionUsage(messages)
  }, [messages])

  const hasResults = usage.resultsWithUsageCount > 0

  const ariaLabel = React.useMemo(() => {
    if (!hasResults) {
      return usage.isIncomplete
        ? '本会话已保存用量：暂无已保存用量（记录不完整，可能低估）'
        : '本会话已保存用量：暂无已保存用量'
    }
    const incompleteSuffix = usage.isIncomplete ? '（记录不完整，可能低估）' : ''
    return `本会话已保存用量：总计 ${usage.totalTokens.toLocaleString()} tokens${incompleteSuffix}`
  }, [hasResults, usage.isIncomplete, usage.totalTokens])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 px-2 gap-1.5 text-xs font-normal text-muted-foreground hover:text-foreground select-none',
            usage.isIncomplete && hasResults && 'text-amber-600/90 dark:text-amber-400/90',
            buttonClassName,
            className,
          )}
          aria-label={ariaLabel}
        >
          <BarChart3 className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">
            {hasResults ? formatCompactTokens(usage.totalTokens) : '用量'}
          </span>
          {usage.isIncomplete && (
            <span
              className="size-1.5 rounded-full bg-amber-500 shrink-0"
              aria-hidden="true"
              title="记录不完整，可能低估"
            />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        className="w-60 p-3"
        role="region"
        aria-label="本会话已保存用量明细"
      >
        <div className="flex flex-col gap-2">
          {/* 标题栏 */}
          <div className="flex items-center justify-between pb-1 border-b border-border/50">
            <span className="text-xs font-medium text-foreground">本会话已保存用量</span>
            {hasResults && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {usage.resultsWithUsageCount} 条记录
              </span>
            )}
          </div>

          {/* 内容展示区 */}
          {hasResults ? (
            <div className="flex flex-col gap-1.5 pt-0.5">
              <DetailRow label="输入" value={usage.inputTokens} />
              <DetailRow label="输出" value={usage.outputTokens} />
              <DetailRow label="缓存读取" value={usage.cacheReadTokens} />
              <DetailRow label="缓存写入" value={usage.cacheCreationTokens} />
              <div className="h-px bg-border/50 my-0.5" />
              <DetailRow label="总计" value={usage.totalTokens} emphasized />
            </div>
          ) : (
            <div className="py-2.5 text-center text-xs text-muted-foreground">
              暂无已保存用量
            </div>
          )}

          {/* 不完整警告提示 */}
          {usage.isIncomplete && (
            <div
              className="flex items-center gap-1.5 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400"
              role="status"
            >
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
              <span>记录不完整，可能低估</span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
