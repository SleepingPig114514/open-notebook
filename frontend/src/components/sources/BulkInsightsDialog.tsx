'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useTransformations } from '@/lib/hooks/use-transformations'
import { useTranslation } from '@/lib/hooks/use-translation'

interface BulkInsightsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Sources the transformation will be queued for. */
  sourceCount: number
  /** Called with the chosen transformation id when the user confirms. */
  onConfirm: (transformationId: string) => void
  isLoading?: boolean
}

/**
 * Transformation picker for bulk insight generation. Shared by the notebook
 * sources column and the sources library page so both entry points get the
 * same "one transformation, N sources" semantics.
 */
export function BulkInsightsDialog({
  open,
  onOpenChange,
  sourceCount,
  onConfirm,
  isLoading = false,
}: BulkInsightsDialogProps) {
  const { t } = useTranslation()
  const { data: transformations, isLoading: loadingTransformations } = useTransformations()
  const [selectedId, setSelectedId] = useState('')

  // Reset the picker whenever the dialog is (re)opened so a stale choice
  // never leaks into the next bulk run.
  useEffect(() => {
    if (open) setSelectedId('')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sources.bulkInsightsTitle')}</DialogTitle>
          <DialogDescription>
            {t('sources.bulkInsightsDescription', { count: sourceCount })}
          </DialogDescription>
        </DialogHeader>

        {loadingTransformations ? (
          <div className="flex items-center justify-center py-6">
            <LoadingSpinner />
          </div>
        ) : (
          <Select value={selectedId} onValueChange={setSelectedId} disabled={isLoading}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('sources.selectTransformation')} />
            </SelectTrigger>
            <SelectContent>
              {(transformations ?? []).map((trans) => (
                <SelectItem key={trans.id} value={trans.id}>
                  {trans.title || trans.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => selectedId && onConfirm(selectedId)}
            disabled={!selectedId || isLoading}
          >
            {isLoading ? (
              <>
                <LoadingSpinner className="mr-2 h-4 w-4" />
                {t('common.creating')}
              </>
            ) : (
              t('sources.bulkInsightsConfirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
