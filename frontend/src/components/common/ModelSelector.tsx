import { useId } from 'react'
import { Label } from '@/components/ui/label'
import { ModelPicker } from '@/components/common/ModelPicker'
import { ReasoningLevel } from '@/lib/types/models'
import { useTranslation } from '@/lib/hooks/use-translation'

/**
 * Labelled model dropdown used by dialogs/forms (Ask advanced models,
 * transformation playground, podcast profiles). Thin wrapper around the
 * unified ModelPicker so every model dropdown in the app shares one style
 * and — for language selectors — one reasoning-level control.
 */
interface ModelSelectorProps {
  id?: string
  name?: string // kept for call-site compatibility; the picker is a button, not a form control
  label?: string
  modelType: 'language' | 'embedding' | 'speech_to_text' | 'text_to_speech'
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /** Show the reasoning (thinking) level group inside the popover. */
  showReasoning?: boolean
  /** Current level; undefined/null = follow provider default. */
  reasoningLevel?: ReasoningLevel | null
  onReasoningChange?: (level: ReasoningLevel | null) => void
}

export function ModelSelector({
  id,
  label,
  modelType,
  value,
  onChange,
  placeholder,
  disabled = false,
  showReasoning = false,
  reasoningLevel = null,
  onReasoningChange
}: ModelSelectorProps) {
  const { t } = useTranslation()
  const derivedId = useId()
  const selectId = id || derivedId

  return (
    <div className="space-y-2">
      {label && <Label htmlFor={selectId}>{label}</Label>}
      <ModelPicker
        id={selectId}
        modelType={modelType}
        value={value}
        onChange={onChange}
        placeholder={placeholder || t('settings.embeddingOptionPlaceholder')}
        disabled={disabled}
        showReasoning={showReasoning && modelType === 'language'}
        reasoningLevel={reasoningLevel}
        onReasoningChange={onReasoningChange}
      />
    </div>
  )
}
