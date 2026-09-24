'use client'

import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { SourceListResponse } from '@/lib/types/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Plus, FileText, Link2, ChevronDown, Loader2, ListChecks, Search, Unlink, Trash2 } from 'lucide-react'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { EmptyState } from '@/components/common/EmptyState'
import { AddSourceDialog } from '@/components/sources/AddSourceDialog'
import { AddExistingSourceDialog } from '@/components/sources/AddExistingSourceDialog'
import { SourceCard } from '@/components/sources/SourceCard'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  useDeleteSource,
  useRetrySource,
  useRemoveSourceFromNotebook,
  useBulkRemoveSourceFromNotebook,
  useBulkDeleteSources,
} from '@/lib/hooks/use-sources'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useModalManager } from '@/lib/hooks/use-modal-manager'
import { ContextMode } from '../[id]/page'
import type { SourceBulkAction } from '@/lib/utils/source-context'
import { CollapsibleColumn, createCollapseButton } from '@/components/notebooks/CollapsibleColumn'
import { useNotebookColumnsStore } from '@/lib/stores/notebook-columns-store'
import { useTranslation } from '@/lib/hooks/use-translation'

interface SourcesColumnProps {
  sources?: SourceListResponse[]
  isLoading: boolean
  notebookId: string
  notebookName?: string
  onRefresh?: () => void
  contextSelections?: Record<string, ContextMode>
  onContextModeChange?: (sourceId: string, mode: ContextMode) => void
  onBulkContextModeChange?: (action: SourceBulkAction) => void
  // Pagination props
  hasNextPage?: boolean
  isFetchingNextPage?: boolean
  fetchNextPage?: () => void
}

export function SourcesColumn({
  sources,
  isLoading,
  notebookId,
  onRefresh,
  contextSelections,
  onContextModeChange,
  onBulkContextModeChange,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: SourcesColumnProps) {
  const { t } = useTranslation()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addExistingDialogOpen, setAddExistingDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [sourceToDelete, setSourceToDelete] = useState<string | null>(null)
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [sourceToRemove, setSourceToRemove] = useState<string | null>(null)
  // Bulk selection state
  const [bulkSearch, setBulkSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkRemoveDialogOpen, setBulkRemoveDialogOpen] = useState(false)
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false)

  const { openModal } = useModalManager()
  const deleteSource = useDeleteSource()
  const retrySource = useRetrySource()
  const removeFromNotebook = useRemoveSourceFromNotebook()
  const bulkRemoveFromNotebook = useBulkRemoveSourceFromNotebook()
  const bulkDeleteSources = useBulkDeleteSources()

  // Plain keyword filter over the loaded sources: matches title/path/topics/URL.
  // Deduplicate by id to guard against pagination bugs causing the same source
  // to appear in multiple pages (#1234).
  const filteredSources = useMemo(() => {
    const q = bulkSearch.trim().toLowerCase()
    if (!q || !sources) return sources ?? []
    const matched = sources.filter((s) =>
      [
        s.title || '',
        s.asset?.url || '',
        s.asset?.file_path || '',
        ...(s.topics || []),
      ].some((h) => h.toLowerCase().includes(q))
    )
    // Dedupe: keep first occurrence of each id
    const seen = new Set<string>()
    return matched.filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })
  }, [sources, bulkSearch])

  const allVisibleSelected =
    filteredSources.length > 0 &&
    filteredSources.every((s) => selectedIds.includes(s.id))

  const handleToggleSelectAll = () => {
    if (allVisibleSelected) {
      const visibleSet = new Set(filteredSources.map((s) => s.id))
      setSelectedIds((prev) => prev.filter((id) => !visibleSet.has(id)))
    } else {
      const merged = new Set(selectedIds)
      filteredSources.forEach((s) => merged.add(s.id))
      setSelectedIds(Array.from(merged))
    }
  }

  const handleToggleSelectOne = (sourceId: string) => {
    setSelectedIds((prev) =>
      prev.includes(sourceId)
        ? prev.filter((id) => id !== sourceId)
        : [...prev, sourceId]
    )
  }

  const resetBulkSelection = () => {
    setSelectedIds([])
    setBulkSearch('')
  }

  const handleBulkRemoveConfirm = async () => {
    if (selectedIds.length === 0) return
    try {
      await bulkRemoveFromNotebook.mutateAsync({
        notebookId,
        sourceIds: selectedIds,
      })
      setBulkRemoveDialogOpen(false)
      resetBulkSelection()
      onRefresh?.()
    } catch (error) {
      console.error('Bulk remove from notebook failed:', error)
    }
  }

  const handleBulkDeleteConfirm = async () => {
    if (selectedIds.length === 0) return
    try {
      await bulkDeleteSources.mutateAsync({ sourceIds: selectedIds })
      setBulkDeleteDialogOpen(false)
      resetBulkSelection()
      onRefresh?.()
    } catch (error) {
      console.error('Bulk remove from sources failed:', error)
    }
  }

  // Collapsible column state
  const { sourcesCollapsed, toggleSources } = useNotebookColumnsStore()
  const collapseButton = useMemo(
    () => createCollapseButton(toggleSources, t('navigation.sources')),
    [toggleSources, t('navigation.sources')]
  )

  // Scroll container ref for infinite scroll
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Handle scroll for infinite loading
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || !hasNextPage || isFetchingNextPage || !fetchNextPage) return

    const { scrollTop, scrollHeight, clientHeight } = container
    // Load more when user scrolls within 200px of the bottom
    if (scrollHeight - scrollTop - clientHeight < 200) {
      fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // Attach scroll listener
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [handleScroll])
  
  const handleDeleteClick = (sourceId: string) => {
    setSourceToDelete(sourceId)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!sourceToDelete) return

    try {
      await deleteSource.mutateAsync(sourceToDelete)
      setDeleteDialogOpen(false)
      setSourceToDelete(null)
      onRefresh?.()
    } catch (error) {
      console.error('Failed to remove source:', error)
    }
  }

  const handleRemoveFromNotebook = (sourceId: string) => {
    setSourceToRemove(sourceId)
    setRemoveDialogOpen(true)
  }

  const handleRemoveConfirm = async () => {
    if (!sourceToRemove) return

    try {
      await removeFromNotebook.mutateAsync({
        notebookId,
        sourceId: sourceToRemove
      })
      setRemoveDialogOpen(false)
      setSourceToRemove(null)
    } catch (error) {
      console.error('Failed to remove source from notebook:', error)
      // Error toast is handled by the hook
    }
  }

  const handleRetry = async (sourceId: string) => {
    try {
      await retrySource.mutateAsync(sourceId)
    } catch (error) {
      console.error('Failed to retry source:', error)
    }
  }

  const handleSourceClick = (sourceId: string) => {
    openModal('source', sourceId)
  }

  return (
    <>
      <CollapsibleColumn
        isCollapsed={sourcesCollapsed}
        onToggle={toggleSources}
        collapsedIcon={FileText}
        collapsedLabel={t('navigation.sources')}
      >
        <Card className="h-full flex flex-col flex-1 overflow-hidden">
          <CardHeader className="pb-3 flex-shrink-0">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                <span aria-hidden className="h-3.5 w-[3px] rounded-full bg-sage" />
                {t('navigation.sources')}
              </CardTitle>
              <div className="flex items-center gap-2">
                {onBulkContextModeChange && sources && sources.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-muted-foreground" title={t('sources.bulkContext')}>
                        <ListChecks className="h-4 w-4" />
                        <ChevronDown className="h-4 w-4 ml-1" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onBulkContextModeChange('insights')}>
                        {t('sources.includeAllInsights')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onBulkContextModeChange('full')}>
                        {t('sources.includeAllFull')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onBulkContextModeChange('exclude')}>
                        {t('sources.excludeAllFromContext')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm">
                      <Plus className="h-4 w-4 mr-2" />
                      {t('sources.addSource')}
                      <ChevronDown className="h-4 w-4 ml-2" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => { setDropdownOpen(false); setAddDialogOpen(true); }}>
                      <Plus className="h-4 w-4 mr-2" />
                      {t('sources.addSource')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { setDropdownOpen(false); setAddExistingDialogOpen(true); }}>
                      <Link2 className="h-4 w-4 mr-2" />
                      {t('sources.addExistingTitle')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {collapseButton}
              </div>
            </div>
          </CardHeader>

          {!isLoading && sources && sources.length > 0 && (
            <div className="flex items-center gap-2 px-4 pb-2 flex-shrink-0">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={bulkSearch}
                  onChange={(e) => setBulkSearch(e.target.value)}
                  placeholder={t('sources.bulkSearchPlaceholder')}
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer select-none" title={t('sources.selectAllFiltered')}>
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={handleToggleSelectAll}
                  disabled={filteredSources.length === 0}
                />
                {t('sources.selectAll')}
              </label>
              {selectedIds.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="h-8 text-xs shrink-0">
                      <ListChecks className="h-3.5 w-3.5 mr-1" />
                      {t('sources.bulkActions', { count: selectedIds.length })}
                      <ChevronDown className="h-3 w-3 ml-1" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setBulkRemoveDialogOpen(true)}>
                      <Unlink className="h-4 w-4 mr-2" />
                      {t('sources.removeFromNotebook')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setBulkDeleteDialogOpen(true)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      {t('sources.removeFromSources')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}

          <CardContent ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <LoadingSpinner />
              </div>
            ) : !sources || sources.length === 0 ? (
              <EmptyState
                icon={FileText}
                title={t('sources.noSourcesYet')}
                description={t('sources.createFirstSource')}
              />
            ) : filteredSources.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <Search className="h-8 w-8 mb-2 opacity-50" />
                <p className="text-sm">{t('common.noMatches')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredSources.map((source) => {
                  return (
                    <div key={source.id} className="flex items-start gap-2">
                      <Checkbox
                        checked={selectedIds.includes(source.id)}
                        onCheckedChange={() => handleToggleSelectOne(source.id)}
                        className="mt-2.5 ml-0.5 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <SourceCard
                          source={source}
                          onClick={handleSourceClick}
                          onDelete={handleDeleteClick}
                          onRetry={handleRetry}
                          onRefreshContent={handleRetry}
                          onRemoveFromNotebook={handleRemoveFromNotebook}
                          onRefresh={onRefresh}
                          showRemoveFromNotebook={true}
                          contextMode={contextSelections?.[source.id]}
                          onContextModeChange={onContextModeChange
                            ? (mode) => onContextModeChange(source.id, mode)
                            : undefined
                          }
                        />
                      </div>
                    </div>
                  )
                })}
                {/* Loading indicator for infinite scroll */}
                {isFetchingNextPage && (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </CollapsibleColumn>

      <AddSourceDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        defaultNotebookId={notebookId}
      />

      <AddExistingSourceDialog
        open={addExistingDialogOpen}
        onOpenChange={setAddExistingDialogOpen}
        notebookId={notebookId}
        onSuccess={onRefresh}
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('sources.removeFromSources')}
        description={t('sources.removeFromSourcesConfirm')}
        confirmText={t('sources.removeFromSources')}
        onConfirm={handleDeleteConfirm}
        isLoading={deleteSource.isPending}
        confirmVariant="destructive"
      />

      <ConfirmDialog
        open={removeDialogOpen}
        onOpenChange={setRemoveDialogOpen}
        title={t('sources.removeFromNotebook')}
        description={t('sources.removeConfirm')}
        confirmText={t('common.remove')}
        onConfirm={handleRemoveConfirm}
        isLoading={removeFromNotebook.isPending}
        confirmVariant="default"
      />

      <ConfirmDialog
        open={bulkRemoveDialogOpen}
        onOpenChange={setBulkRemoveDialogOpen}
        title={t('sources.removeFromNotebook')}
        description={t('sources.bulkRemoveNotebookConfirm', { count: selectedIds.length })}
        confirmText={t('common.remove')}
        onConfirm={handleBulkRemoveConfirm}
        isLoading={bulkRemoveFromNotebook.isPending}
        confirmVariant="default"
      />

      <ConfirmDialog
        open={bulkDeleteDialogOpen}
        onOpenChange={setBulkDeleteDialogOpen}
        title={t('sources.removeFromSources')}
        description={t('sources.bulkRemoveSourcesConfirm', { count: selectedIds.length })}
        confirmText={t('sources.removeFromSources')}
        onConfirm={handleBulkDeleteConfirm}
        isLoading={bulkDeleteSources.isPending}
        confirmVariant="destructive"
      />
    </>
  )
}
