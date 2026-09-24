import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { toast as sonnerToast } from 'sonner'
import { sourcesApi } from '@/lib/api/sources'
import { embeddingApi } from '@/lib/api/embedding'
import { QUERY_KEYS } from '@/lib/api/query-client'
import { useToast } from '@/lib/hooks/use-toast'
import { useTranslation } from '@/lib/hooks/use-translation'
import { getApiErrorMessage } from '@/lib/utils/error-handler'
import {
  CreateSourceRequest,
  UpdateSourceRequest,
  SourceResponse,
  SourceStatusResponse,
  SourceListResponse
} from '@/lib/types/api'

const NOTEBOOK_SOURCES_PAGE_SIZE = 30

// Limit concurrent writes to avoid overwhelming SurrealDB: it has no
// connection pool (each request opens its own), and firing dozens of DELETEs
// at once produces write-transaction contention where some records survive
// even though every response is 200.
const BULK_CONCURRENCY = 4

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => void
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  let done = 0
  async function run() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i]) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
      done += 1
      onProgress?.(done, items.length)
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run())
  await Promise.all(runners)
  return results
}

export function useSources(notebookId?: string) {
  return useQuery({
    queryKey: QUERY_KEYS.sources(notebookId),
    queryFn: () => sourcesApi.list({ notebook_id: notebookId }),
    enabled: !!notebookId,
    staleTime: 5 * 1000, // 5 seconds - more responsive for real-time source updates
    refetchOnWindowFocus: true, // Refetch when user comes back to the tab
  })
}

/**
 * Hook for fetching notebook sources with infinite scroll pagination.
 * Returns flattened sources array and pagination controls.
 */
export function useNotebookSources(notebookId: string) {
  const queryClient = useQueryClient()

  const query = useInfiniteQuery({
    queryKey: QUERY_KEYS.sourcesInfinite(notebookId),
    queryFn: async ({ pageParam = 0 }) => {
      const data = await sourcesApi.list({
        notebook_id: notebookId,
        limit: NOTEBOOK_SOURCES_PAGE_SIZE,
        offset: pageParam,
        sort_by: 'updated',
        sort_order: 'desc',
      })
      return {
        sources: data,
        nextOffset: data.length === NOTEBOOK_SOURCES_PAGE_SIZE ? pageParam + data.length : undefined,
      }
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
    enabled: !!notebookId,
    staleTime: 5 * 1000,
    refetchOnWindowFocus: true,
  })

  // Flatten all pages into a single array (memoized to prevent infinite re-renders)
  const sources: SourceListResponse[] = useMemo(
    () => query.data?.pages.flatMap(page => page.sources) ?? [],
    [query.data?.pages]
  )

  // Refetch function that resets to first page
  const refetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sourcesInfinite(notebookId) })
  }, [queryClient, notebookId])

  return {
    sources,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch,
    error: query.error,
  }
}

export function useSource(id: string) {
  return useQuery({
    queryKey: QUERY_KEYS.source(id),
    queryFn: () => sourcesApi.get(id),
    enabled: !!id,
    staleTime: 30 * 1000, // 30 seconds - shorter stale time for more responsive updates
    refetchOnWindowFocus: true, // Refetch when user comes back to the tab
  })
}

export function useCreateSource() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (data: CreateSourceRequest) => sourcesApi.create(data),
    onSuccess: (result: SourceResponse, variables) => {
      // Invalidate queries for all relevant notebooks with immediate refetch
      if (variables.notebooks) {
        variables.notebooks.forEach(notebookId => {
          queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.sources(notebookId),
            refetchType: 'active'
          })
          queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.sourcesInfinite(notebookId),
            refetchType: 'active'
          })
        })
      } else if (variables.notebook_id) {
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.sources(variables.notebook_id),
          refetchType: 'active'
        })
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.sourcesInfinite(variables.notebook_id),
          refetchType: 'active'
        })
      }

      // Invalidate general sources query too with immediate refetch
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.sources(),
        refetchType: 'active'
      })

      // Show different messages based on processing mode
      if (variables.async_processing) {
        toast({
          title: t('sources.sourceQueued'),
          description: t('sources.sourceQueuedDesc'),
        })
      } else {
        toast({
          title: t('common.success'),
          description: t('sources.sourceAddedSuccess'),
        })
      }
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.failedToAddSource')),
        variant: 'destructive',
      })
    },
  })
}

export function useUpdateSource() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateSourceRequest }) =>
      sourcesApi.update(id, data),
    onSuccess: (_, { id }) => {
      // Invalidate ALL sources queries (both general and notebook-specific)
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.source(id) })
      toast({
        title: t('common.success'),
        description: t('sources.sourceUpdatedSuccess'),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.failedToUpdateSource')),
        variant: 'destructive',
      })
    },
  })
}

export function useDeleteSource() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (id: string) => sourcesApi.delete(id),
    onSuccess: (_, id) => {
      // Invalidate ALL sources queries (both general and notebook-specific)
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      // Also invalidate the specific source
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.source(id) })
      toast({
        title: t('common.success'),
        description: t('sources.sourceDeletedSuccess'),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.failedToDeleteSource')),
        variant: 'destructive',
      })
    },
  })
}

export function useFileUpload() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: ({ file, notebookId }: { file: File; notebookId: string }) =>
      sourcesApi.upload(file, notebookId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.sources(variables.notebookId)
      })
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.sourcesInfinite(variables.notebookId),
        refetchType: 'active'
      })
      toast({
        title: t('common.success'),
        description: t('sources.fileUploadedSuccess'),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.failedToUploadFile')),
        variant: 'destructive',
      })
    },
  })
}

export function useSourceStatus(sourceId: string, enabled = true) {
  return useQuery({
    queryKey: ['sources', sourceId, 'status'],
    queryFn: () => sourcesApi.status(sourceId),
    enabled: !!sourceId && enabled,
    refetchInterval: (query) => {
      // Auto-refresh every 2 seconds if processing
      // The query.state.data contains the SourceStatusResponse
      const data = query.state.data as SourceStatusResponse | undefined
      if (data?.status === 'running' || data?.status === 'queued' || data?.status === 'new') {
        return 2000
      }
      // No auto-refresh if completed, failed, or unknown
      return false
    },
    staleTime: 0, // Always consider status data stale for real-time updates
    retry: (failureCount, error) => {
      // Don't retry on 404 (source not found)
      const axiosError = error as { response?: { status?: number } }
      if (axiosError?.response?.status === 404) {
        return false
      }
      return failureCount < 3
    },
  })
}

export function useRetrySource() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (sourceId: string) => sourcesApi.retry(sourceId),
    onSuccess: (result, sourceId) => {
      // Invalidate status query to refetch latest status
      queryClient.invalidateQueries({
        queryKey: ['sources', sourceId, 'status']
      })
      // Invalidate ALL sources queries to refresh the UI
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.source(sourceId) })

      toast({
        title: t('sources.sourceRequeued'),
        description: t('sources.sourceRequeuedDesc'),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.failedToRetry')),
        variant: 'destructive',
      })
    },
  })
}

export function useAddSourcesToNotebook() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: async ({ notebookId, sourceIds }: { notebookId: string; sourceIds: string[] }) => {
      const { notebooksApi } = await import('@/lib/api/notebooks')

      // Limit concurrency to keep SurrealDB write transactions from contending
      const results = await runWithConcurrency(
        sourceIds, BULK_CONCURRENCY,
        sourceId => notebooksApi.addSource(notebookId, sourceId)
      )

      // Count successes and failures
      const successes = results.filter(r => r.status === 'fulfilled').length
      const failures = results.filter(r => r.status === 'rejected').length

      return { successes, failures, total: sourceIds.length }
    },
    onSuccess: (result, { notebookId, sourceIds }) => {
      // Invalidate ALL sources queries to refresh all lists
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      // Specifically invalidate the notebook's sources
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sources(notebookId) })
      // Invalidate each affected source
      sourceIds.forEach(sourceId => {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.source(sourceId) })
      })

      // Show appropriate toast based on results
      if (result.failures === 0) {
        toast({
          title: t('common.success'),
          description: t('sources.sourcesAddedToNotebook', { count: result.successes }),
        })
      } else if (result.successes === 0) {
        toast({
          title: t('common.error'),
          description: t('sources.failedToAddSourcesToNotebook'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('common.success'),
          description: t('sources.partialAddSuccess', { success: result.successes.toString(), failed: result.failures.toString() }),
          variant: 'default',
        })
      }
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.failedToAddSourcesToNotebook')),
        variant: 'destructive',
      })
    },
  })
}

export function useRemoveSourceFromNotebook() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: async ({ notebookId, sourceId }: { notebookId: string; sourceId: string }) => {
      // This will call the API we created
      const { notebooksApi } = await import('@/lib/api/notebooks')
      return notebooksApi.removeSource(notebookId, sourceId)
    },
    onSuccess: (_, { notebookId, sourceId }) => {
      // Invalidate ALL sources queries to refresh all lists
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      // Specifically invalidate the notebook's sources
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sources(notebookId) })
      // Also invalidate the specific source
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.source(sourceId) })

      toast({
        title: t('common.success'),
        description: t('sources.sourceRemovedFromNotebook'),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.failedToRemoveSourceFromNotebook')),
        variant: 'destructive',
      })
    },
  })
}

/**
 * Bulk-unlink sources from a notebook. Calls the per-source endpoint for each
 * id (same pattern as useAddSourcesToNotebook) and reports partial failures;
 * the sources stay in the global source library and disk files are untouched.
 */
export function useBulkRemoveSourceFromNotebook() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: async ({ notebookId, sourceIds }: { notebookId: string; sourceIds: string[] }) => {
      const { notebooksApi } = await import('@/lib/api/notebooks')
      const results = await runWithConcurrency(
        sourceIds, BULK_CONCURRENCY,
        sourceId => notebooksApi.removeSource(notebookId, sourceId)
      )
      const successes = results.filter(r => r.status === 'fulfilled').length
      const failures = results.filter(r => r.status === 'rejected').length
      return { successes, failures, total: sourceIds.length }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      if (result.failures === 0) {
        toast({
          title: t('common.success'),
          description: t('sources.bulkRemovedNotebookSuccess', { count: result.successes }),
        })
      } else if (result.successes === 0) {
        toast({
          title: t('common.error'),
          description: t('sources.bulkFailed'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('common.success'),
          description: t('sources.bulkPartialFail', {
            success: result.successes.toString(),
            failed: result.failures.toString(),
          }),
        })
      }
    },
    onError: (error: unknown) => {
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.bulkFailed')),
        variant: 'destructive',
      })
    },
  })
}

/**
 * Bulk-remove sources from the whole library. DELETEs are issued STRICTLY
 * ONE AT A TIME (concurrency = 1): SurrealDB silently loses concurrent
 * deletes on the indexed `source` table — even 2 in flight can leave 1
 * survivor while every response is 200. After each delete we re-fetch to
 * confirm the record is gone and retry if not. External originals are never
 * deleted (Source.delete only unlinks managed uploads).
 */
const DELETE_VERIFY_ATTEMPTS = 3

export function useBulkDeleteSources() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: async ({ sourceIds }: { sourceIds: string[] }) => {
      const failedIds: string[] = []

      const verifyDelete = async (sourceId: string) => {
        for (let attempt = 1; attempt <= DELETE_VERIFY_ATTEMPTS; attempt++) {
          await sourcesApi.delete(sourceId)
          // Confirm gone: a 404 means it no longer exists (success).
          try {
            await sourcesApi.get(sourceId)
          } catch {
            return // 404/error -> record is gone
          }
          // Still present after a 200 delete: loop and retry.
        }
        throw new Error(`source ${sourceId} survived ${DELETE_VERIFY_ATTEMPTS} deletes`)
      }

      await runWithConcurrency(
        sourceIds, 1,
        async (sourceId) => {
          try {
            await verifyDelete(sourceId)
          } catch (e) {
            failedIds.push(sourceId)
            throw e
          }
        },
        (done, total) => {
          sonnerToast.loading(t('sources.bulkDeleteInProgress'), {
            id: 'bulk-delete-progress',
            description: `${done} / ${total}`,
          })
        }
      )

      const failures = failedIds.length
      const successes = sourceIds.length - failures
      return { successes, failures, total: sourceIds.length }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      sonnerToast.dismiss('bulk-delete-progress')
      if (result.failures === 0) {
        toast({
          title: t('common.success'),
          description: t('sources.bulkRemovedSourcesSuccess', { count: result.successes }),
        })
      } else if (result.successes === 0) {
        toast({
          title: t('common.error'),
          description: t('sources.bulkFailed'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('common.success'),
          description: t('sources.bulkPartialFail', {
            success: result.successes.toString(),
            failed: result.failures.toString(),
          }),
        })
      }
    },
    onError: (error: unknown) => {
      sonnerToast.dismiss('bulk-delete-progress')
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.bulkFailed')),
        variant: 'destructive',
      })
    },
  })
}

/**
 * Bulk (re-)vectorize selected sources. Each call submits an independent
 * background embed_source job via POST /api/embed - safe to re-run on
 * already-embedded sources (embed_source deletes old chunks first).
 * Submissions are bounded (BULK_CONCURRENCY) because every request opens
 * its own SurrealDB connection (no pooling). Progress + success/failure
 * counts are reported before a single cache invalidation.
 */
export function useBulkEmbedSources() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: async ({ sourceIds }: { sourceIds: string[] }) => {
      let failures = 0
      await runWithConcurrency(
        sourceIds,
        BULK_CONCURRENCY,
        async (sourceId) => {
          try {
            await embeddingApi.embedContent(sourceId, 'source')
          } catch (e) {
            failures += 1
            throw e
          }
        },
        (done, total) => {
          sonnerToast.loading(t('sources.bulkEmbedInProgress'), {
            id: 'bulk-embed-progress',
            description: `${done} / ${total}`,
          })
        }
      )
      const successes = sourceIds.length - failures
      return { successes, failures, total: sourceIds.length }
    },
    onSuccess: (result) => {
      sonnerToast.dismiss('bulk-embed-progress')
      queryClient.invalidateQueries({ queryKey: ['sources'] })
      if (result.failures === 0) {
        toast({
          title: t('common.success'),
          description: t('sources.bulkEmbedQueuedSuccess', { count: result.successes }),
        })
      } else if (result.successes === 0) {
        toast({
          title: t('common.error'),
          description: t('sources.bulkFailed'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('common.success'),
          description: t('sources.bulkPartialFail', {
            success: result.successes.toString(),
            failed: result.failures.toString(),
          }),
        })
      }
    },
    onError: (error: unknown) => {
      sonnerToast.dismiss('bulk-embed-progress')
      toast({
        title: t('common.error'),
        description: getApiErrorMessage(error, (key) => t(key), t('sources.bulkFailed')),
        variant: 'destructive',
      })
    },
  })
}
