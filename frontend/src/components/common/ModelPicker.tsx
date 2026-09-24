'use client'

import { useState } from 'react'
import { Check, ChevronDown, Brain } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useModels } from '@/lib/hooks/use-models'
import { Model, ReasoningLevel } from '@/lib/types/models'
import { cn } from '@/lib/utils'

/**
 * Unified model dropdown (the single place model-selector styling lives).
 *
 * Beyond picking a model, language selectors optionally show a reasoning
 * (thinking) level group inside the same popover — mirroring the Hermes
 * composer pattern: 默认 (factory) / 关闭 / low / medium / xhigh. The level
 * is a per-slot request parameter, not a model property; the parent owns
 * storage (DefaultModels.model_args).
 */

const REASONING_LEVELS: ReasoningLevel[] = ['off', 'low', 'medium', 'xhigh']

// Explicit label mapping: the i18n unused-key detector greps source statically,
// so template-literal keys (models.reasoningLevel.${level}) would be flagged.
const REASONING_LABEL_KEYS: Record<ReasoningLevel, string> = {
  off: 'models.reasoningLevel.off',
  low: 'models.reasoningLevel.low',
  medium: 'models.reasoningLevel.medium',
  xhigh: 'models.reasoningLevel.xhigh',
}

interface ModelPickerProps {
  modelType: 'language' | 'embedding' | 'speech_to_text' | 'text_to_speech'
  /** Currently selected model id ('' when none). */
  value: string
  onChange: (modelId: string) => void
  /** Show the reasoning-level group (language selectors only). */
  showReasoning?: boolean
  /** Current reasoning level; undefined/null = follow provider default. */
  reasoningLevel?: ReasoningLevel | null
  onReasoningChange?: (level: ReasoningLevel | null) => void
  /** When set, a "clear" item is shown above the model list. */
  onClear?: () => void
  clearLabel?: string
  placeholder?: string
  emptyLabel?: string
  disabled?: boolean
  className?: string
  triggerClassName?: string
  id?: string
}

export function ModelPicker({
  modelType,
  value,
  onChange,
  showReasoning = false,
  reasoningLevel = null,
  onReasoningChange,
  onClear,
  clearLabel,
  placeholder,
  emptyLabel,
  disabled = false,
  className,
  triggerClassName,
  id,
}: ModelPickerProps) {
  const { t } = useTranslation()
  const { data: models, isLoading } = useModels()
  const [open, setOpen] = useState(false)

  const filteredModels = (models ?? []).filter(m => m.type === modelType)
  const selected = filteredModels.find(m => m.id === value)

  const levelLabel = (level: ReasoningLevel | null): string => {
    if (!level) return t('models.reasoningDefault')
    return t(REASONING_LABEL_KEYS[level])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-8 w-full items-center justify-between gap-1 whitespace-nowrap rounded-md border border-input bg-transparent px-2.5 py-2 text-xs shadow-xs transition-colors outline-none',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'disabled:cursor-not-allowed disabled:opacity-50',
            triggerClassName
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-left">
            {selected ? (
              <>
                <span className="truncate">{selected.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {selected.provider}
                </span>
                {showReasoning && (
                  <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
                    <Brain className="h-2.5 w-2.5" />
                    {levelLabel(reasoningLevel)}
                  </span>
                )}
              </>
            ) : (
              <span className="truncate text-muted-foreground">
                {placeholder || t('models.selectModelPlaceholder')}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn('w-(--radix-popover-trigger-width) min-w-56 p-0', className)}
      >
        <div className="max-h-64 overflow-y-auto p-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-3">
              <LoadingSpinner size="sm" />
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="px-2 py-2 text-sm text-muted-foreground">
              {emptyLabel || t('common.noResults')}
            </div>
          ) : (
            <>
              {onClear && (
                <button
                  type="button"
                  onClick={() => {
                    onClear()
                    setOpen(false)
                  }}
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-muted-foreground outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                >
                  {clearLabel || t('models.noneOption')}
                </button>
              )}
              <p className="px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t('models.reasoningGroupModels')}
              </p>
              {filteredModels
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((model: Model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      onChange(model.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground',
                      value === model.id && 'font-medium'
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-left">
                      <span className="truncate">{model.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {model.provider}
                      </span>
                    </span>
                    {value === model.id && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                ))}
            </>
          )}
        </div>

        {showReasoning && onReasoningChange && (
          <div className="border-t p-1">
            <p className="px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {t('models.reasoningGroupLabel')}
            </p>
            <button
              type="button"
              onClick={() => {
                onReasoningChange(null)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground',
                !reasoningLevel && 'font-medium'
              )}
            >
              <span className="text-left">{t('models.reasoningDefault')}</span>
              {!reasoningLevel && <Check className="h-3.5 w-3.5 shrink-0" />}
            </button>
            <Separator className="my-1" />
            {REASONING_LEVELS.map(level => (
              <button
                key={level}
                type="button"
                onClick={() => {
                  onReasoningChange(level)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground',
                  reasoningLevel === level && 'font-medium'
                )}
              >
                <span className="text-left">{t(REASONING_LABEL_KEYS[level])}</span>
                {reasoningLevel === level && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
