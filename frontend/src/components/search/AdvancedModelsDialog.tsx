'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ModelSelector } from '@/components/common/ModelSelector'
import { ReasoningLevel } from '@/lib/types/models'
import { useTranslation } from '@/lib/hooks/use-translation'

export interface AskModelSelection {
  strategy: string
  answer: string
  finalAnswer: string
  strategyReasoning?: ReasoningLevel | null
  answerReasoning?: ReasoningLevel | null
  finalAnswerReasoning?: ReasoningLevel | null
}

interface AdvancedModelsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultModels: AskModelSelection
  onSave: (models: AskModelSelection) => void
}

export function AdvancedModelsDialog({
  open,
  onOpenChange,
  defaultModels,
  onSave
}: AdvancedModelsDialogProps) {
  const { t } = useTranslation()
  const [strategyModel, setStrategyModel] = useState(defaultModels.strategy)
  const [answerModel, setAnswerModel] = useState(defaultModels.answer)
  const [finalAnswerModel, setFinalAnswerModel] = useState(defaultModels.finalAnswer)
  const [strategyReasoning, setStrategyReasoning] = useState<ReasoningLevel | null>(defaultModels.strategyReasoning ?? null)
  const [answerReasoning, setAnswerReasoning] = useState<ReasoningLevel | null>(defaultModels.answerReasoning ?? null)
  const [finalAnswerReasoning, setFinalAnswerReasoning] = useState<ReasoningLevel | null>(defaultModels.finalAnswerReasoning ?? null)

  // Update local state when defaultModels change
  useEffect(() => {
    setStrategyModel(defaultModels.strategy)
    setAnswerModel(defaultModels.answer)
    setFinalAnswerModel(defaultModels.finalAnswer)
    setStrategyReasoning(defaultModels.strategyReasoning ?? null)
    setAnswerReasoning(defaultModels.answerReasoning ?? null)
    setFinalAnswerReasoning(defaultModels.finalAnswerReasoning ?? null)
  }, [defaultModels])

  const handleSave = () => {
    onSave({
      strategy: strategyModel,
      answer: answerModel,
      finalAnswer: finalAnswerModel,
      strategyReasoning,
      answerReasoning,
      finalAnswerReasoning
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('searchPage.advancedModelTitle')}</DialogTitle>
          <DialogDescription>
            {t('searchPage.advancedModelDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <ModelSelector
            label={t('searchPage.strategyModel')}
            modelType="language"
            value={strategyModel}
            onChange={setStrategyModel}
            placeholder={t('searchPage.selectStrategyPlaceholder')}
            showReasoning
            reasoningLevel={strategyReasoning}
            onReasoningChange={setStrategyReasoning}
          />

          <ModelSelector
            label={t('searchPage.answerModel')}
            modelType="language"
            value={answerModel}
            onChange={setAnswerModel}
            placeholder={t('searchPage.selectAnswerPlaceholder')}
            showReasoning
            reasoningLevel={answerReasoning}
            onReasoningChange={setAnswerReasoning}
          />

          <ModelSelector
            label={t('searchPage.finalAnswerModel')}
            modelType="language"
            value={finalAnswerModel}
            onChange={setFinalAnswerModel}
            placeholder={t('searchPage.selectFinalPlaceholder')}
            showReasoning
            reasoningLevel={finalAnswerReasoning}
            onReasoningChange={setFinalAnswerReasoning}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave}>
            {t('searchPage.saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
