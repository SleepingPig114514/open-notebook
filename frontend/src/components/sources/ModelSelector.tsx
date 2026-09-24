'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { ModelPicker } from '@/components/common/ModelPicker'
import { ReasoningLevel } from '@/lib/types/models'

const VALID_LEVELS: readonly string[] = ['off', 'low', 'medium', 'xhigh']
const asLevel = (v?: string | null): ReasoningLevel | null =>
  v && (VALID_LEVELS as readonly string[]).includes(v) ? (v as ReasoningLevel) : null

/**
 * Chat-panel model selector. Thin wrapper around the unified ModelPicker:
 * the session-level model override plus its own reasoning (thinking) level.
 * "Clear" falls back to the default chat model (whose slot-level reasoning
 * is configured in Settings -> Models).
 */
interface ModelSelectorProps {
  currentModel?: string
  onModelChange: (model?: string) => void
  disabled?: boolean
  /** Session-level reasoning level; undefined/null = follow slot/default. */
  reasoningLevel?: string | null
  onReasoningChange?: (level: string | null) => void
}

export function ModelSelector({
  currentModel,
  onModelChange,
  disabled = false,
  reasoningLevel = null,
  onReasoningChange
}: ModelSelectorProps) {
  const { t } = useTranslation()

  return (
    <ModelPicker
      modelType="language"
      value={currentModel ?? ''}
      onChange={(modelId) => onModelChange(modelId || undefined)}
      onClear={() => onModelChange(undefined)}
      clearLabel={t('transformations.systemDefault')}
      placeholder={t('transformations.systemDefault')}
      disabled={disabled}
      showReasoning={Boolean(onReasoningChange)}
      reasoningLevel={asLevel(reasoningLevel)}
      onReasoningChange={(level) => onReasoningChange?.(level)}
      className="w-64"
      triggerClassName="h-7 text-xs max-w-64"
    />
  )
}
