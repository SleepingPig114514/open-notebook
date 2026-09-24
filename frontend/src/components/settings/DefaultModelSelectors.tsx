'use client'

import { useState, useEffect, useId } from 'react'
import { useForm } from 'react-hook-form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Loader2, AlertCircle, Wand2 } from 'lucide-react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useUpdateModelDefaults, useAutoAssignDefaults } from '@/lib/hooks/use-models'
import { Model, ModelDefaults, ReasoningLevel } from '@/lib/types/models'
import { ModelType } from '@/lib/providers'
import { ModelPicker } from '@/components/common/ModelPicker'
import { EmbeddingModelChangeDialog } from './EmbeddingModelChangeDialog'

interface DefaultConfig {
  key: ModelSlotKey
  label: string
  description: string
  modelType: ModelType
  required?: boolean
  /** When unset, this default falls back to the chat default (see open_notebook/ai/models.py). */
  fallsBackToChat?: boolean
  id: string
}

// A model slot (excludes the model_args container field itself).
type ModelSlotKey = Exclude<keyof ModelDefaults, 'model_args'>

interface DefaultModelSelectProps {
  config: DefaultConfig
  available: Model[]
  currentValue?: string
  onChange: (key: ModelSlotKey, value: string) => void
  showDescription?: boolean
  /** Name of the currently selected chat model, used for the fallback hint. */
  chatModelName?: string
  /** Per-slot reasoning (thinking) level; null/undefined = provider default. */
  reasoningLevel?: ReasoningLevel | null
  onReasoningChange?: (key: ModelSlotKey, level: ReasoningLevel | null) => void
}

function DefaultModelSelect({
  config,
  available,
  currentValue,
  onChange,
  showDescription,
  chatModelName,
  reasoningLevel,
  onReasoningChange,
}: DefaultModelSelectProps) {
  const { t } = useTranslation()
  const isValid = currentValue && available.some(m => m.id === currentValue)

  // Hint shown when an optional slot is left empty, clarifying the effective
  // behavior (chat-model fallback vs. feature unavailable) — see #1098.
  const emptyOptionalHint = (() => {
    if (config.required || currentValue) return null
    if (config.fallsBackToChat) {
      return chatModelName
        ? t('models.usingChatModelHint', { model: chatModelName })
        : null
    }
    if (config.modelType === 'text_to_speech') return t('models.ttsUnsetHint')
    if (config.modelType === 'speech_to_text') return t('models.sttUnsetHint')
    return null
  })()

  return (
    <div className="space-y-1">
      <Label htmlFor={config.id} className="text-xs">
        {config.label}
        {config.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <ModelPicker
        id={config.id}
        modelType={config.modelType}
        value={currentValue || ''}
        onChange={(v) => onChange(config.key, v)}
        placeholder={
          config.required && !isValid && available.length > 0
            ? t('models.requiredModelPlaceholder')
            : undefined
        }
        triggerClassName={
          config.required && !isValid && available.length > 0 ? 'border-destructive' : undefined
        }
        showReasoning={config.modelType === 'language'}
        reasoningLevel={reasoningLevel}
        onReasoningChange={
          onReasoningChange ? (level) => onReasoningChange(config.key, level) : undefined
        }
        onClear={config.required ? undefined : () => onChange(config.key, '')}
        clearLabel={
          config.fallsBackToChat ? t('models.noneFallbackToChat') : t('models.noneOption')
        }
      />
      {emptyOptionalHint && (
        <p className="text-[10px] text-muted-foreground leading-tight italic">{emptyOptionalHint}</p>
      )}
      {showDescription && (
        <p className="text-[10px] text-muted-foreground leading-tight">{config.description}</p>
      )}
    </div>
  )
}

interface DefaultModelSelectorsProps {
  models: Model[]
  defaults: ModelDefaults
}

export function DefaultModelSelectors({
  models,
  defaults,
}: DefaultModelSelectorsProps) {
  const { t } = useTranslation()
  const updateDefaults = useUpdateModelDefaults()
  const autoAssign = useAutoAssignDefaults()
  const { setValue, watch } = useForm<ModelDefaults>({ defaultValues: defaults })
  const generatedId = useId()

  const [showEmbeddingDialog, setShowEmbeddingDialog] = useState(false)
  const [pendingEmbeddingChange, setPendingEmbeddingChange] = useState<{
    key: keyof ModelDefaults; value: string; oldModelId?: string; newModelId?: string
  } | null>(null)

  useEffect(() => {
    if (defaults) {
      Object.entries(defaults).forEach(([key, value]) => {
        setValue(key as keyof ModelDefaults, value)
      })
    }
  }, [defaults, setValue])

  const primaryConfigs: DefaultConfig[] = [
    { key: 'default_chat_model', label: t('models.chatModelLabel'), description: t('models.chatModelDesc'), modelType: 'language', required: true, id: `${generatedId}-chat` },
    { key: 'default_embedding_model', label: t('models.embeddingModelLabel'), description: t('models.embeddingModelDesc'), modelType: 'embedding', required: true, id: `${generatedId}-embed` },
    { key: 'default_text_to_speech_model', label: t('models.ttsModelLabel'), description: t('models.ttsModelDesc'), modelType: 'text_to_speech', id: `${generatedId}-tts` },
    { key: 'default_speech_to_text_model', label: t('models.sttModelLabel'), description: t('models.sttModelDesc'), modelType: 'speech_to_text', id: `${generatedId}-stt` },
  ]

  const advancedConfigs: DefaultConfig[] = [
    { key: 'default_transformation_model', label: t('models.transformationModelLabel'), description: t('models.transformationModelDesc'), modelType: 'language', fallsBackToChat: true, id: `${generatedId}-transform` },
    { key: 'default_tools_model', label: t('models.toolsModelLabel'), description: t('models.toolsModelDesc'), modelType: 'language', fallsBackToChat: true, id: `${generatedId}-tools` },
    { key: 'large_context_model', label: t('models.largeContextModelLabel'), description: t('models.largeContextModelDesc'), modelType: 'language', fallsBackToChat: true, id: `${generatedId}-large` },
  ]

  const defaultConfigs = [...primaryConfigs, ...advancedConfigs]

  const handleChange = (key: ModelSlotKey, value: string) => {
    if (key === 'default_embedding_model') {
      const current = defaults[key]
      if (current && current !== value) {
        setPendingEmbeddingChange({ key, value, oldModelId: current, newModelId: value })
        setShowEmbeddingDialog(true)
        return
      }
    }
    updateDefaults.mutate({ [key]: value || null })
  }

  // Per-slot reasoning (thinking) level. model_args is a whole dict on the
  // API, so merge locally and send the full map; null clears the slot.
  const handleReasoningChange = (key: ModelSlotKey, level: ReasoningLevel | null) => {
    const next: Record<string, ReasoningLevel> = { ...(defaults.model_args ?? {}) }
    if (level === null) delete next[key]
    else next[key] = level
    updateDefaults.mutate({ model_args: next })
  }

  const handleConfirmEmbeddingChange = () => {
    if (pendingEmbeddingChange) {
      updateDefaults.mutate({ [pendingEmbeddingChange.key]: pendingEmbeddingChange.value || null })
      setPendingEmbeddingChange(null)
    }
  }

  const getModelsForType = (type: ModelType) => models.filter(m => m.type === type)

  const chatModelName = models.find(m => m.id === watch('default_chat_model'))?.name

  const missingRequired = defaultConfigs
    .filter(c => {
      if (!c.required) return false
      const value = defaults[c.key]
      if (!value) return true
      return !models.filter(m => m.type === c.modelType).some(m => m.id === value)
    })
    .map(c => c.label)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('models.defaultAssignments')}</CardTitle>
        <CardDescription>{t('models.defaultAssignmentsDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {missingRequired.length > 0 && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{t('models.missingRequiredModels', { models: missingRequired.join(', ') })}</span>
              <Button
                variant="outline" size="sm"
                onClick={() => autoAssign.mutate()}
                disabled={autoAssign.isPending}
                className="shrink-0 gap-1.5"
              >
                {autoAssign.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                {autoAssign.isPending ? t('models.autoAssigning') : t('models.autoAssign')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Primary models: Chat, Embedding, TTS, STT */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {primaryConfigs.map(config => (
            <DefaultModelSelect
              key={config.key}
              config={config}
              available={getModelsForType(config.modelType)}
              currentValue={watch(config.key) || undefined}
              onChange={handleChange}
              chatModelName={chatModelName}
              reasoningLevel={defaults.model_args?.[config.key]}
              onReasoningChange={handleReasoningChange}
            />
          ))}
        </div>

        {/* Advanced models: Transformation, Tools, Large Context */}
        <div className="border-t pt-3">
          <p className="text-xs text-muted-foreground mb-3">{t('navigation.advanced')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {advancedConfigs.map(config => (
                <DefaultModelSelect
                  key={config.key}
                  config={config}
                  available={getModelsForType(config.modelType)}
                  currentValue={watch(config.key) || undefined}
                  onChange={handleChange}
                  showDescription
                  chatModelName={chatModelName}
                  reasoningLevel={defaults.model_args?.[config.key]}
                  onReasoningChange={handleReasoningChange}
                />
              ))}
            </div>
        </div>
      </CardContent>

      <EmbeddingModelChangeDialog
        open={showEmbeddingDialog}
        onOpenChange={(open) => { if (!open) { setPendingEmbeddingChange(null); setShowEmbeddingDialog(false) } }}
        onConfirm={handleConfirmEmbeddingChange}
        oldModelName={pendingEmbeddingChange?.oldModelId ? models.find(m => m.id === pendingEmbeddingChange.oldModelId)?.name : undefined}
        newModelName={pendingEmbeddingChange?.newModelId ? models.find(m => m.id === pendingEmbeddingChange.newModelId)?.name : undefined}
      />
    </Card>
  )
}
