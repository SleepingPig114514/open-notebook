'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Search, Link2, LoaderIcon, FileText, Link as LinkIcon, Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { sourcesApi } from '@/lib/api/sources'
import { useSources, useAddSourcesToNotebook } from '@/lib/hooks/use-sources'
import { SourceListResponse } from '@/lib/types/api'
import { useTranslation } from '@/lib/hooks/use-translation'

interface AddExistingSourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  notebookId: string
  onSuccess?: () => void
}

const PAGE_SIZE = 100

export function AddExistingSourceDialog({
  open,
  onOpenChange,
  notebookId,
  onSuccess,
}: AddExistingSourceDialogProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [allSources, setAllSources] = useState<SourceListResponse[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)

  // Sources already linked to this notebook
  const { data: currentNotebookSources } = useSources(notebookId)
  const currentSourceIds = useMemo(
    () => new Set(currentNotebookSources?.map(s => s.id) || []),
    [currentNotebookSources]
  )

  const addSources = useAddSourcesToNotebook()

  // Load every source; the API returns at most 100 per page, so paginate.
  const loadAllSources = useCallback(async () => {
    try {
      setIsLoading(true)
      const collected: SourceListResponse[] = []
      let offset = 0
      for (let page = 0; page < 50; page++) {
        const batch = await sourcesApi.list({
          limit: PAGE_SIZE,
          offset,
          sort_by: 'created',
          sort_order: 'desc',
        })
        collected.push(...batch)
        offset += batch.length
        if (batch.length < PAGE_SIZE) break
      }
      setTruncated(collected.length >= 50 * PAGE_SIZE)
      setAllSources(collected)
    } catch (error) {
      console.error('Error loading sources:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      loadAllSources()
    } else {
      setSearchQuery('')
      setSelectedSourceIds([])
      setTruncated(false)
    }
  }, [open, loadAllSources])

  // Plain keyword matching against the title (which carries the relative
  // path for folder imports), URL, file path and topics. No search backend.
  const filteredSources = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return allSources
    return allSources.filter((s) =>
      [
        s.title || '',
        s.asset?.url || '',
        s.asset?.file_path || '',
        ...(s.topics || []),
      ].some((h) => h.toLowerCase().includes(q))
    )
  }, [allSources, searchQuery])

  const selectableIds = useMemo(
    () =>
      filteredSources
        .filter((s) => !currentSourceIds.has(s.id))
        .map((s) => s.id),
    [filteredSources, currentSourceIds]
  )

  const allVisibleSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedSourceIds.includes(id))

  const handleToggleSource = (sourceId: string) => {
    setSelectedSourceIds((prev) =>
      prev.includes(sourceId)
        ? prev.filter((id) => id !== sourceId)
        : [...prev, sourceId]
    )
  }

  const handleSelectAllVisible = () => {
    if (allVisibleSelected) {
      const visibleSet = new Set(selectableIds)
      setSelectedSourceIds((prev) => prev.filter((id) => !visibleSet.has(id)))
    } else {
      const merged = new Set(selectedSourceIds)
      selectableIds.forEach((id) => merged.add(id))
      setSelectedSourceIds(Array.from(merged))
    }
  }

  const handleAddSelected = async () => {
    if (selectedSourceIds.length === 0) return

    try {
      await addSources.mutateAsync({
        notebookId,
        sourceIds: selectedSourceIds,
      })

      setSelectedSourceIds([])
      setSearchQuery('')
      onOpenChange(false)
      onSuccess?.()
    } catch (error) {
      console.error('Error adding sources:', error)
    }
  }

  const getSourceIcon = (source: SourceListResponse) => {
    if (source.asset?.url) return <LinkIcon className="h-4 w-4" />
    if (source.asset?.file_path) return <Upload className="h-4 w-4" />
    return <FileText className="h-4 w-4" />
  }

  const formatDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleDateString()
    } catch {
      return ''
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            {t('sources.addExistingTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('sources.addExistingDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('sources.titleSearchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              autoFocus
            />
          </div>

          {/* Select all */}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={handleSelectAllVisible}
                disabled={selectableIds.length === 0}
              />
              {t('sources.selectAllFiltered')}
            </label>
            <span className="text-xs text-muted-foreground">
              {t('sources.filteredCount', { count: filteredSources.length })}
            </span>
          </div>

          {/* List */}
          <ScrollArea className="h-[360px] border rounded-md">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center h-[200px] text-muted-foreground">
                <LoaderIcon className="h-12 w-12 mb-2 animate-spin" />
                <p>{t('common.loading')}</p>
              </div>
            ) : filteredSources.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[200px] text-muted-foreground">
                <FileText className="h-12 w-12 mb-2 opacity-50" />
                <p>{t('sources.noNotebooksFound')}</p>
              </div>
            ) : (
              <div className="space-y-2 p-4">
                {filteredSources.map((source) => {
                  const isAlreadyLinked = currentSourceIds.has(source.id)
                  const isSelected = selectedSourceIds.includes(source.id)

                  return (
                    <div
                      key={source.id}
                      className={`flex items-start gap-3 p-3 rounded-md transition-colors min-w-0 ${
                        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                      }`}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => handleToggleSource(source.id)}
                        disabled={isAlreadyLinked}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2 mb-1">
                          <div className="shrink-0 mt-0.5">
                            {getSourceIcon(source)}
                          </div>
                          <h4 className="font-medium text-sm break-words line-clamp-2 flex-1 min-w-0">
                            {source.title}
                          </h4>
                          {isAlreadyLinked && (
                            <Badge variant="secondary" className="text-xs shrink-0">
                              {t('common.linked')}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {t('sources.added', { date: formatDate(source.created) })}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </ScrollArea>

          {truncated && (
            <p className="text-xs text-muted-foreground">{t('sources.tooManySources')}</p>
          )}

          {selectedSourceIds.length > 0 && (
            <div className="text-sm text-muted-foreground">
              {t('sources.selectedCount', { count: selectedSourceIds.length })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={addSources.isPending}
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleAddSelected}
            disabled={selectedSourceIds.length === 0 || addSources.isPending}
          >
            {addSources.isPending ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                {t('common.adding')}
              </>
            ) : (
              <>{t('common.addSelected')}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
