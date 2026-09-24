'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { sourcesApi, type SourceSortField } from '@/lib/api/sources'
import { SourceListResponse } from '@/lib/types/api'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { EmptyState } from '@/components/common/EmptyState'
import { AppShell } from '@/components/layout/AppShell'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { FileText, Trash2, ArrowDown, ArrowUp, ArrowUpDown, Plus, Search, Database, Square } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTranslation } from '@/lib/hooks/use-translation'
import { getDateLocale } from '@/lib/utils/date-locale'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { getApiErrorKey } from '@/lib/utils/error-handler'
import { AddSourceDialog } from '@/components/sources/AddSourceDialog'
import { embeddingApi } from '@/lib/api/embedding'
import { useBulkDeleteSources, useBulkEmbedSources } from '@/lib/hooks/use-sources'

export default function SourcesPage() {
  const { t, language } = useTranslation()
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const failedToLoadMessage = t('sources.failedToLoad')
  const [sources, setSources] = useState<SourceListResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [sortBy, setSortBy] = useState<SourceSortField>('updated')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; source: SourceListResponse | null }>({
    open: false,
    source: null
  })
  const router = useRouter()
  const tableRef = useRef<HTMLTableElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const hasMoreRef = useRef(true)
  // Monotonic token: a response whose token is no longer current belongs to
  // a superseded request (StrictMode remount / sort change fired a newer
  // fetch) and must be dropped entirely — otherwise stale offset=0 responses
  // resolve out of order and corrupt offsetRef/hasMoreRef, which stalls
  // pagination after the first 30 rows on remount/refresh.
  const requestSeqRef = useRef(0)
  const PAGE_SIZE = 30

  // Bulk selection: keyword filter + multi-select + bulk remove.
  const [bulkSearch, setBulkSearch] = useState('')
  const [embedFilter, setEmbedFilter] = useState<'all' | 'embedded' | 'missing'>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false)
  const [bulkEmbedDialogOpen, setBulkEmbedDialogOpen] = useState(false)
  const [bulkStopDialogOpen, setBulkStopDialogOpen] = useState(false)
  // Per-row in-flight cancel requests (button disabled while the POST runs).
  const [stoppingEmbedIds, setStoppingEmbedIds] = useState<Set<string>>(new Set())
  const bulkDeleteSources = useBulkDeleteSources()
  const bulkEmbedSources = useBulkEmbedSources()

  // Sources with a vectorization job in flight (new/running embed_source
  // command). While non-empty, poll the lightweight active-status endpoint
  // (no list refetch - the list is infinite-scroll paginated, a reset would
  // truncate already-loaded pages) and update badges in place. Once every
  // job finishes, one full refetch syncs the embedded flags.
  const activeEmbedIds = useMemo(
    () => sources.filter((s) => s.embedding_active).map((s) => s.id),
    [sources]
  )
  const activeEmbedIdsKey = activeEmbedIds.join(',')

  const fetchSources = useCallback(async (reset = false) => {
    let seq = 0
    try {
      // Check flags before proceeding
      if (!reset && (loadingMoreRef.current || !hasMoreRef.current)) {
        return
      }

      if (reset) {
        // Any in-flight append from a previous mount/sort is now stale;
        // clear its flag so the guard below rejects it cleanly.
        loadingMoreRef.current = false
        setLoading(true)
        offsetRef.current = 0
        setSources([])
        hasMoreRef.current = true
      } else {
        loadingMoreRef.current = true
        setLoadingMore(true)
      }

      seq = ++requestSeqRef.current

      const data = await sourcesApi.list({
        limit: PAGE_SIZE,
        offset: offsetRef.current,
        sort_by: sortBy,
        sort_order: sortOrder,
        ...(embedFilter === 'all' ? {} : { embedded: embedFilter === 'embedded' ? 'true' : 'false' }),
      })

      // A newer request (remount reset / sort change) superseded this one:
      // drop the response without touching state or the pagination refs.
      const stale = seq !== requestSeqRef.current
      if (stale) return

      if (reset) {
        setSources(data)
      } else {
        setSources(prev => [...prev, ...data])
      }

      // Check if we have more data
      const hasMoreData = data.length === PAGE_SIZE
      hasMoreRef.current = hasMoreData
      offsetRef.current += data.length
    } catch (err) {
      console.error('Failed to fetch sources:', err)
      // Stale failures belong to a superseded request; don't surface them.
      if (seq === requestSeqRef.current) {
        setError(failedToLoadMessage)
        toast.error(failedToLoadMessage)
      }
    } finally {
      // Stale responses (a newer reset/request won the race) must not clear
      // the loading flags owned by the current request.
      if (seq === requestSeqRef.current) {
        setLoading(false)
        setLoadingMore(false)
        loadingMoreRef.current = false
      }
    }
  }, [sortBy, sortOrder, failedToLoadMessage, embedFilter])

  // Initial load and when sort changes
  useEffect(() => {
    fetchSources(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortBy, sortOrder, embedFilter])

  // Poll active vectorization jobs while any badge is showing; update rows
  // in place and refetch once when all jobs have settled.
  useEffect(() => {
    if (!activeEmbedIdsKey) return
    const ids = activeEmbedIdsKey.split(',')
    let cancelled = false
    const poll = async () => {
      try {
        const status = await embeddingApi.getActiveStatus(ids)
        if (cancelled) return
        const stillActive = new Set(status.active_ids)
        const canceling = new Set(status.cancel_requested_ids)
        setSources((prev) =>
          prev.map((s) =>
            ids.includes(s.id)
              ? {
                  ...s,
                  embedding_active: stillActive.has(s.id),
                  embedding_cancel_requested:
                    stillActive.has(s.id) && canceling.has(s.id),
                }
              : s
          )
        )
        if (stillActive.size === 0) {
          // All in-flight jobs done/failed/cancelled: sync embedded flags once.
          fetchSources(true)
        }
      } catch {
        // Transient poll failure - next tick retries.
      }
    }
    const timer = setInterval(poll, 10000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEmbedIdsKey])

  useEffect(() => {
    // Focus the table when component mounts or sources change
    if (sources.length > 0 && tableRef.current) {
      tableRef.current.focus()
    }
  }, [sources])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (sources.length === 0) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => {
            const newIndex = Math.min(prev + 1, sources.length - 1)
            // Scroll to keep selected row visible
            setTimeout(() => scrollToSelectedRow(newIndex), 0)
            return newIndex
          })
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => {
            const newIndex = Math.max(prev - 1, 0)
            // Scroll to keep selected row visible
            setTimeout(() => scrollToSelectedRow(newIndex), 0)
            return newIndex
          })
          break
        case 'Enter':
          e.preventDefault()
          if (sources[selectedIndex]) {
            router.push(`/sources/${sources[selectedIndex].id}`)
          }
          break
        case 'Home':
          e.preventDefault()
          setSelectedIndex(0)
          setTimeout(() => scrollToSelectedRow(0), 0)
          break
        case 'End':
          e.preventDefault()
          const lastIndex = sources.length - 1
          setSelectedIndex(lastIndex)
          setTimeout(() => scrollToSelectedRow(lastIndex), 0)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [sources, selectedIndex, router])

  const scrollToSelectedRow = (index: number) => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    // Find the selected row element
    const rows = scrollContainer.querySelectorAll('tbody tr')
    const selectedRow = rows[index] as HTMLElement
    if (!selectedRow) return

    const containerRect = scrollContainer.getBoundingClientRect()
    const rowRect = selectedRow.getBoundingClientRect()

    // Check if row is above visible area
    if (rowRect.top < containerRect.top) {
      selectedRow.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    // Check if row is below visible area
    else if (rowRect.bottom > containerRect.bottom) {
      selectedRow.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }

  // Set up scroll listener after sources are loaded
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    let scrollTimeout: NodeJS.Timeout | null = null

    const handleScroll = () => {
      if (scrollTimeout) {
        clearTimeout(scrollTimeout)
      }

      scrollTimeout = setTimeout(() => {
        if (!scrollContainerRef.current) return
        // Don't fire an "append" while the initial reset page is in flight:
        // on a fresh mount the empty list measures at the bottom, which used
        // to launch a duplicate offset=0 request and race the reset. The
        // effect re-runs (loading flips false) and re-checks afterwards.
        if (loading) return

        const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight

        // Load more when within 200px of the bottom
        if (distanceFromBottom < 200 && !loadingMoreRef.current && hasMoreRef.current) {
          fetchSources(false)
        }
      }, 100)
    }

    scrollContainer.addEventListener('scroll', handleScroll)
    handleScroll() // Check on mount

    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll)
      if (scrollTimeout) {
        clearTimeout(scrollTimeout)
      }
    }
  }, [fetchSources, sources.length, loading])

  const toggleSort = (field: SourceSortField) => {
    setSelectedIndex(0)
    if (sortBy === field) {
      // Toggle order if clicking the same field
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      // Switch to new field with default desc order
      setSortBy(field)
      setSortOrder('desc')
    }
  }

  const renderSortableHeader = (
    field: SourceSortField,
    label: string,
    align: 'left' | 'center' = 'left'
  ) => {
    const active = sortBy === field
    const SortIcon = active ? (sortOrder === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown

    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => toggleSort(field)}
        className={cn(
          "h-8 px-2 hover:bg-muted",
          align === 'center' && "mx-auto"
        )}
      >
        {label}
        <SortIcon className={cn(
          "ml-2 h-3 w-3",
          active ? 'opacity-100' : 'opacity-30'
        )} />
      </Button>
    )
  }

  // Content-type pebble — type hues live in dots, never washes
  const getSourceTypeDotClass = (source: SourceListResponse) => {
    if (source.asset?.url) return 'bg-type-web'
    if (source.asset?.file_path) return 'bg-type-pdf'
    return 'bg-type-note'
  }

  const getSourceType = (source: SourceListResponse) => {
    if (source.asset?.url) return t('sources.type.link')
    if (source.asset?.file_path) return t('sources.type.file')
    return t('sources.type.text')
  }

  const handleRowClick = useCallback((index: number, sourceId: string) => {
    setSelectedIndex(index)
    router.push(`/sources/${sourceId}`)
  }, [router])

  const handleDeleteClick = useCallback((e: React.MouseEvent, source: SourceListResponse) => {
    e.stopPropagation() // Prevent row click
    setDeleteDialog({ open: true, source })
  }, [])

  const handleDeleteConfirm = async () => {
    if (!deleteDialog.source) return

    try {
      await sourcesApi.delete(deleteDialog.source.id)
      toast.success(t('sources.deleteSuccess'))
      // Remove the deleted source from the list
      setSources(prev => prev.filter(s => s.id !== deleteDialog.source?.id))
      setDeleteDialog({ open: false, source: null })
    } catch (err: unknown) {
      const error = err as { response?: { data?: { detail?: string } }, message?: string };
      console.error('Failed to delete source:', error)
      toast.error(t(getApiErrorKey(error.response?.data?.detail || error.message)))
    }
  }

  // Keyword filter over the currently loaded sources (title/path/topics/URL).
  const filteredSources = useMemo(() => {
    const q = bulkSearch.trim().toLowerCase()
    if (!q) return sources
    return sources.filter((s) =>
      [
        s.title || '',
        s.asset?.url || '',
        s.asset?.file_path || '',
        ...(s.topics || []),
      ].some((h) => h.toLowerCase().includes(q))
    )
  }, [sources, bulkSearch])

  const visibleIds = useMemo(() => filteredSources.map((s) => s.id), [filteredSources])
  const sourceIndexById = useMemo(() => {
    const m = new Map<string, number>()
    sources.forEach((s, i) => m.set(s.id, i))
    return m
  }, [sources])
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))

  const handleToggleSelectAll = () => {
    if (allVisibleSelected) {
      const visibleSet = new Set(visibleIds)
      setSelectedIds((prev) => prev.filter((id) => !visibleSet.has(id)))
    } else {
      const merged = new Set(selectedIds)
      visibleIds.forEach((id) => merged.add(id))
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

  const handleBulkDeleteConfirm = async () => {
    if (selectedIds.length === 0) return
    try {
      await bulkDeleteSources.mutateAsync({ sourceIds: selectedIds })
      setBulkDeleteDialogOpen(false)
      setSelectedIds([])
      setBulkSearch('')
      fetchSources(true)
    } catch (err) {
      console.error('Bulk delete failed:', err)
    }
  }

  const handleBulkEmbedConfirm = async () => {
    if (selectedIds.length === 0) return
    try {
      await bulkEmbedSources.mutateAsync({ sourceIds: selectedIds })
      setBulkEmbedDialogOpen(false)
      setSelectedIds([])
      fetchSources(true)
    } catch (err) {
      console.error('Bulk embed failed:', err)
    }
  }

  // Selected sources that currently have a vectorization job in flight.
  const selectedActiveIds = useMemo(
    () => selectedIds.filter((id) => activeEmbedIds.includes(id)),
    [selectedIds, activeEmbedIds]
  )

  const handleBulkStopConfirm = async () => {
    if (selectedActiveIds.length === 0) return
    let failures = 0
    let cancelled = 0
    // Cancel each active job individually (these are cheap UPDATEs; the
    // number of in-flight jobs is bounded by the worker's max-tasks).
    for (const id of selectedActiveIds) {
      try {
        const res = await embeddingApi.cancelEmbedding(id)
        cancelled += res.cancelled_commands
      } catch (err) {
        failures += 1
        console.error(`Failed to cancel embedding for ${id}:`, err)
      }
    }
    setBulkStopDialogOpen(false)
    setSelectedIds([])
    if (failures > 0) {
      toast.error(t('sources.embedCancelFailed'))
    } else if (cancelled === 0) {
      // All picked jobs had already finished before the click.
      toast.success(t('sources.embedCancelNone'))
    } else {
      toast.success(t('sources.embedCancelSuccess'))
    }
    fetchSources(true)
  }

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center">
          <LoadingSpinner />
        </div>
      )
    }

    if (error) {
      return (
        <div className="flex h-full items-center justify-center">
          <p className="text-destructive">{error}</p>
        </div>
      )
    }

    if (sources.length === 0) {
      return (
        <EmptyState
          icon={FileText}
          title={t('sources.noSourcesYet')}
          description={t('sources.allSourcesDescShort')}
          action={
            <Button onClick={() => setSourceDialogOpen(true)} variant="outline" className="mt-4">
              <Plus className="h-4 w-4 mr-2" />
              {t('sources.newSource')}
            </Button>
          }
        />
      )
    }

    return (<>
      <div className="flex flex-col h-full w-full max-w-none px-6 py-6">
        <div className="mb-6 flex-shrink-0 flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight">{t('sources.allSources')}</h1>
            <p className="mt-2 text-muted-foreground">
              {t('sources.allSourcesDesc')}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1 shrink-0">
            <Select value={embedFilter} onValueChange={(v) => setEmbedFilter(v as 'all' | 'embedded' | 'missing')}>
              <SelectTrigger className="h-8 w-40 text-xs" aria-label={t('sources.embedFilterLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('sources.embedFilterAll')}</SelectItem>
                <SelectItem value="missing">{t('sources.embedFilterMissing')}</SelectItem>
                <SelectItem value="embedded">{t('sources.embedFilterEmbedded')}</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={bulkSearch}
                onChange={(e) => setBulkSearch(e.target.value)}
                placeholder={t('sources.bulkSearchPlaceholder')}
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <label
              className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer select-none"
              title={t('sources.selectAllFiltered')}
            >
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={handleToggleSelectAll}
                disabled={visibleIds.length === 0}
              />
              {t('sources.selectAll')}
            </label>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs shrink-0"
              disabled={selectedIds.length === 0 || bulkEmbedSources.isPending}
              onClick={() => setBulkEmbedDialogOpen(true)}
            >
              <Database className="h-3.5 w-3.5 mr-1" />
              {t('sources.bulkEmbedSelected', { count: selectedIds.length })}
            </Button>
            {selectedActiveIds.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs shrink-0 text-amber-600 hover:text-amber-700"
                onClick={() => setBulkStopDialogOpen(true)}
              >
                <Square className="h-3.5 w-3.5 mr-1" />
                {t('sources.bulkStopEmbedSelected', { count: selectedActiveIds.length })}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs shrink-0 text-destructive hover:text-destructive"
              disabled={selectedIds.length === 0}
              onClick={() => setBulkDeleteDialogOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {t('sources.bulkActions', { count: selectedIds.length })}
            </Button>
          </div>
        </div>

        <div ref={scrollContainerRef} className="flex-1 rounded-md border overflow-auto">
          <table
            ref={tableRef}
            tabIndex={0}
            className="w-full min-w-[970px] outline-none table-fixed"
          >
            <colgroup>
              <col className="w-[44px]" />
              <col className="w-[120px]" />
              <col className="w-auto" />
              <col className="w-[140px]" />
              <col className="w-[140px]" />
              <col className="w-[100px]" />
              <col className="w-[100px]" />
              <col className="w-[100px]" />
            </colgroup>
            <thead className="sticky top-0 bg-background z-10">
              <tr className="border-b">
                <th className="h-12 px-3 text-center align-middle">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={handleToggleSelectAll}
                    disabled={visibleIds.length === 0}
                    aria-label={t('sources.selectAllFiltered')}
                  />
                </th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                  {renderSortableHeader('type', t('common.type'))}
                </th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                  {renderSortableHeader('title', t('common.title'))}
                </th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground hidden sm:table-cell">
                  {renderSortableHeader('created', t('common.created_label'))}
                </th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground hidden sm:table-cell">
                  {renderSortableHeader('updated', t('common.updated_label'))}
                </th>
                <th className="h-12 px-4 text-center align-middle font-medium text-muted-foreground hidden md:table-cell">
                  {renderSortableHeader('insights_count', t('sources.insights'), 'center')}
                </th>
                <th className="h-12 px-4 text-center align-middle font-medium text-muted-foreground hidden lg:table-cell">
                  {renderSortableHeader('embedded', t('sources.embedded'), 'center')}
                </th>
                <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredSources.map((source) => {
                const index = sourceIndexById.get(source.id) ?? 0
                const rowSelected = selectedIndex === index
                return (
                <tr
                  key={source.id}
                  onClick={() => handleRowClick(index, source.id)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={cn(
                    "border-b transition-colors cursor-pointer",
                    rowSelected
                      ? "bg-accent"
                      : "hover:bg-[var(--surface-raised)]"
                  )}
                >
                  <td className="h-12 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.includes(source.id)}
                      onCheckedChange={() => handleToggleSelectOne(source.id)}
                      aria-label={source.title || t('sources.untitledSource')}
                    />
                  </td>
                  <td className="h-12 px-4">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn('h-2 w-2 shrink-0 rounded-full', getSourceTypeDotClass(source))}
                      />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {getSourceType(source)}
                      </span>
                    </div>
                  </td>
                  <td className="h-12 px-4">
                    <div className="flex flex-col overflow-hidden">
                      <span className="font-medium truncate">
                        {source.title || t('sources.untitledSource')}
                      </span>
                      {source.asset?.url && (
                        <span className="text-xs text-muted-foreground truncate">
                          {source.asset.url}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="h-12 px-4 text-muted-foreground text-sm hidden sm:table-cell">
                    {formatDistanceToNow(new Date(source.created), { 
                      addSuffix: true,
                      locale: getDateLocale(language)
                    })}
                  </td>
                  <td className="h-12 px-4 text-muted-foreground text-sm hidden sm:table-cell">
                    {formatDistanceToNow(new Date(source.updated), {
                      addSuffix: true,
                      locale: getDateLocale(language)
                    })}
                  </td>
                  <td className="h-12 px-4 text-center hidden md:table-cell">
                    <span className="text-sm font-medium">{source.insights_count || 0}</span>
                  </td>
                  <td className="h-12 px-4 text-center hidden lg:table-cell">
                    {source.embedding_active ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-medium",
                          source.embedding_cancel_requested
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : "bg-sky-500/15 text-sky-700 dark:text-sky-400"
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "h-1.5 w-1.5 animate-pulse rounded-full",
                            source.embedding_cancel_requested ? "bg-amber-500" : "bg-sky-500"
                          )}
                        />
                        {source.embedding_cancel_requested
                          ? t('sources.embeddingCanceling')
                          : t('sources.embeddingInProgress')}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium",
                          source.embedded
                            ? "bg-fern-tint text-fern-deep dark:text-fern"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {source.embedded ? t('sources.yes') : t('sources.no')}
                      </span>
                    )}
                  </td>
                  <td className="h-12 px-4 text-right">
                    {source.embedding_active && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={source.embedding_cancel_requested || stoppingEmbedIds.has(source.id)}
                        onClick={async (e) => {
                          e.stopPropagation()
                          setStoppingEmbedIds((prev) => new Set(prev).add(source.id))
                          try {
                            const res = await embeddingApi.cancelEmbedding(source.id)
                            if (res.cancelled_commands > 0) {
                              // Flip the badge in place; the poll clears it once
                              // the worker actually stops the job.
                              setSources((prev) =>
                                prev.map((s) =>
                                  s.id === source.id
                                    ? { ...s, embedding_cancel_requested: true }
                                    : s
                                )
                              )
                              toast.success(t('sources.embedCancelSuccess'))
                            } else {
                              // Nothing was in flight - the job finished before
                              // the click. Say so and sync the stale badge now.
                              toast.success(t('sources.embedCancelNone'))
                              setSources((prev) =>
                                prev.map((s) =>
                                  s.id === source.id
                                    ? { ...s, embedding_active: false, embedding_cancel_requested: false }
                                    : s
                                )
                              )
                              fetchSources(true)
                            }
                          } catch {
                            toast.error(t('sources.embedCancelFailed'))
                          } finally {
                            setStoppingEmbedIds((prev) => {
                              const next = new Set(prev)
                              next.delete(source.id)
                              return next
                            })
                          }
                        }}
                        title={t('sources.stopEmbedTooltip')}
                        className="text-amber-600 hover:text-amber-700"
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => handleDeleteClick(e, source)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
                )
              })}
              {loadingMore && (
                <tr>
                  <td colSpan={8} className="h-16 text-center">
                    <div className="flex items-center justify-center">
                      <LoadingSpinner />
                      <span className="ml-2 text-muted-foreground">{t('sources.loadingMore')}</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={deleteDialog.open}
        onOpenChange={(open) => setDeleteDialog({ open, source: deleteDialog.source })}
        title={t('sources.delete')}
        description={t('sources.deleteConfirmWithTitle', { title: deleteDialog.source?.title || t('sources.untitledSource') })}
        confirmText={t('common.delete')}
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
      />

      <ConfirmDialog
        open={bulkDeleteDialogOpen}
        onOpenChange={setBulkDeleteDialogOpen}
        title={t('sources.removeFromSources')}
        description={t('sources.bulkRemoveSourcesConfirm', { count: selectedIds.length })}
        confirmText={t('sources.removeFromSources')}
        confirmVariant="destructive"
        onConfirm={handleBulkDeleteConfirm}
        isLoading={bulkDeleteSources.isPending}
      />

      <ConfirmDialog
        open={bulkEmbedDialogOpen}
        onOpenChange={setBulkEmbedDialogOpen}
        title={t('sources.bulkEmbedConfirmTitle')}
        description={t('sources.bulkEmbedConfirmDesc', { count: selectedIds.length })}
        confirmText={t('sources.bulkEmbedConfirmTitle')}
        onConfirm={handleBulkEmbedConfirm}
        isLoading={bulkEmbedSources.isPending}
      />

      <ConfirmDialog
        open={bulkStopDialogOpen}
        onOpenChange={setBulkStopDialogOpen}
        title={t('sources.bulkStopEmbedConfirmTitle')}
        description={t('sources.bulkStopEmbedConfirmDesc', { count: selectedActiveIds.length })}
        confirmText={t('sources.bulkStopEmbedConfirmTitle')}
        onConfirm={handleBulkStopConfirm}
      />
    </>)
  }

  return (
    <AppShell>
      {renderContent()}
      <AddSourceDialog
        open={sourceDialogOpen}
        onOpenChange={(open) => {
          setSourceDialogOpen(open)
          if (!open) fetchSources(true)
        }}
      />
    </AppShell>
  )
}
