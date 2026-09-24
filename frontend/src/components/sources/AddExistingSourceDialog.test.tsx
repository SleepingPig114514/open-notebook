import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddExistingSourceDialog } from './AddExistingSourceDialog'
import { sourcesApi } from '@/lib/api/sources'
import type { SourceListResponse } from '@/lib/types/api'

vi.mock('@/lib/api/sources', () => ({
  sourcesApi: { list: vi.fn() },
}))

const mutateAsync = vi.fn()
vi.mock('@/lib/hooks/use-sources', () => ({
  useSources: () => ({ data: [] }),
  useAddSourcesToNotebook: () => ({ mutateAsync, isPending: false }),
}))

const mockList = vi.mocked(sourcesApi.list)

function makeSource(id: string, title: string): SourceListResponse {
  return {
    id,
    title,
    topics: [],
    asset: null,
    embedded: false,
    embedded_chunks: 0,
    insights_count: 0,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
  }
}

describe('AddExistingSourceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue([
      makeSource('source:shared', 'shared doc one'),
      makeSource('source:other', 'unrelated doc'),
    ])
  })

  it('filters loaded sources by title keyword without a search backend', async () => {
    render(
      <AddExistingSourceDialog
        open={true}
        onOpenChange={vi.fn()}
        notebookId="notebook:1"
      />
    )

    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(screen.getByText('shared doc one')).toBeInTheDocument()
    expect(screen.getByText('unrelated doc')).toBeInTheDocument()

    fireEvent.change(
      screen.getByPlaceholderText('sources.titleSearchPlaceholder'),
      { target: { value: 'shared' } }
    )

    expect(screen.getByText('shared doc one')).toBeInTheDocument()
    expect(screen.queryByText('unrelated doc')).not.toBeInTheDocument()
  })
})
