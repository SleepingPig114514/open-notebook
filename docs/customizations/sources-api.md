# Sources API & Folder Import

Verified against the local install (v1.14.0 + local modifications). Re-check line numbers after upgrades; the guards below are architectural and unlikely to move.

## Source ingestion facts (`api/routers/sources.py`)

- Stock source types are exactly three: `link` (URL), `upload` (file), `text` (raw content) — built in `_build_content_state`.
- **upload type has an LFI guard**: `file_path` must resolve inside `data/uploads/`, otherwise HTTP 400. The STOCK upload API cannot be pointed at arbitrary external directories — use the folder-import endpoint below for that.
- **link type SSRF guard** (`open_notebook/utils/url_validation.py`) is self-hosting-friendly: allows private IPs and 127.0.0.1/localhost; only rejects non-http(s) schemes, malformed URLs, and link-local addresses. A local HTTP file server as a link source IS reachable.
- `POST /api/sources` — multipart form. Fields: `type`, `notebook_id` or `notebooks` (JSON array), `url`, `content`, `title`, `transformations` (JSON array), `embed`, `delete_source`, `async_processing`, `file`. `async_processing=true` returns immediately after queueing; poll `GET /api/sources/{id}/status` for queued/running/completed/failed.
- `POST /api/sources/json` — JSON payload variant, no file upload (legacy).
- Retry: `POST /api/sources/{id}/retry` re-processes the SAME asset; refused while status is running/queued.
- No stock directory watching: `watchfiles` in the dependency tree is uvicorn hot-reload only.

## Folder import (LOCAL feature, added in-repo — not upstream)

Local modification adding bulk import + idempotent sync of a local directory. Files STAY in place; the Source's `asset.file_path` points at the original file (bypasses the uploads-folder LFI guard by design — the user explicitly chooses the folder).

- Backend: `api/folder_import_service.py` + `POST /api/sources/import-folder` (payload: `path`, `notebooks`, `embed`, `recursive`). Frontend: 'folder' type tab in `AddSourceDialog` (path input + recursive checkbox), source type `'folder'` in the zod schema.
- **Repeating the call with the same path IS the sync**: new files → created; changed (file mtime newer than source.updated) → old source DELETED and recreated (loses insights/chat on that source — user accepted this tradeoff); missing files → sources deleted; unchanged → skipped. Returns counts `{added, updated, deleted, unchanged, unsupported}`.
- **Title = path structure**: title is the path relative to the import root (e.g. `漆器工序/雕漆/xxx.md`); each subdirectory segment becomes a source `topics` entry. This is how the user navigates/locates imported files — do not 'improve' titles to content-derived ones; `save_source` only overwrites placeholder titles.
- Guards: hidden files/dirs skipped, junk dirs (`.git`, `node_modules`, `__pycache__`, …) pruned, extension allowlist, MAX_FILES=5000.
- Processing goes through the normal async `process_source` command; default transformations are NOT applied on folder import (explicit v1 choice).

### Pitfalls hit while building it (do not repeat)

- **SurrealDB function names are snake_case**: `string::starts_with`, NOT `startsWith`. A camelCase function name gives a 500 'Parse error: Invalid function/constant path' — the error text names the correct function, read it before guessing.
- **Wrap every write in transaction-conflict retry**: SurrealDB v2 throws read/write conflicts when the worker processes freshly-queued sources while the API keeps creating more (same tables). Use the `_tx_retry` helper in `folder_import_service.py` (exponential backoff, ~10 attempts) around every `source.save()` / `add_to_notebook` / `delete` / `submit_command_job` in any bulk loop. Stock background commands survive via their own 15-attempt retry config — synchronous API loops need their own.
- A failed bulk import leaves earlier sources committed (no overall transaction). Re-running the same import treats them as 'unchanged' and fills in the rest — safe to just retry.

### CRITICAL — deletion must never touch external original files

- Stock `Source.delete()` (`open_notebook/domain/notebook.py`) did `os.unlink(asset.file_path)` unconditionally — it assumes every file_path is an uploads-folder COPY. Folder-import sources point at the user's ORIGINAL file, so a stock delete permanently erased the user's real file (os.unlink bypasses the Recycle Bin). Local patch: `Source.delete()` now deletes the physical file ONLY when it resolves inside `data/uploads/`; external paths are logged and skipped. `graphs/source.py` `delete_source=True` path got the same uploads-folder guard. Re-apply both guards after every upstream upgrade.
- Standing user rule: folder-imported sources are LINKS. Deleting a source removes only the link + DB records; the original file must never be modified or deleted by anything. Any future bulk-delete UI must offer 'remove from notebook' (unlink) as the destructive-free default and never batch-physical-delete external files.
- To recover such a loss, the only trail is the API log line 'Deleted file for source ...: <path>' — use it to enumerate what to rescan.

## Choosing an import route for a local knowledge folder

Use the in-repo folder import (above) — it replaced the earlier standalone-watcher plan after the user chose a UI-integrated, manual-sync approach. Do NOT build a local HTTP server + URL imports: link sources snapshot content at ingest (edits never propagate), cannot discover new files, and route md/pdf through the URL HTML cleaner instead of file parsers.

## Notebook = the isolation boundary

Sources and Notebooks are many-to-many; chat/notes/search context is scoped per notebook. The global 'Sources' page is a flat management view with no filtering — do not add a second grouping entity for sources; filter or use notebooks instead. Folder import assigns everything to the notebooks passed in the request (user confirmed: subfolders stay within one notebook, path structure preserved via title/topics).

## Frontend bulk-selection features (local modifications)

`AddExistingSourceDialog` ('添加现有来源') was rewritten: search is a **client-side keyword substring match on title/path/topics/URL** (the stock version called the semantic search API, which does not match titles — useless for path filtering), loads ALL sources via pagination (stock stopped at 100), and has a select-all-filtered-results checkbox. When extending: keep search client-side and literal; only reach for the search API when content-body search is actually wanted.

### Source-deletion naming and button semantics (user-mandated)

- Every physical-delete entry point is labeled **'从来源中移除'** (Remove from Sources) — i18n keys `sources.removeFromSources` / `sources.removeFromSourcesConfirm`; the stock keys `sources.deleteSource` / `deleteSourceConfirm` were removed. The confirm text must state the disk file is NOT deleted. Do not reintroduce a '删除来源' label or the old keys.
- Notebook sources column keeps BOTH actions: '从笔记本中移除' (unlink) and '从来源中移除' (physical delete via `useDeleteSource`). Both exist side by side — do not 'simplify' one away again; the user explicitly wants the shortcut.
- After removing any i18n key, grep `src/` for BOTH the section-qualified and bare key name before deleting — `deleteSource` also exists as a hook name (`useDeleteSource`), and keys like `searchPlaceholder` repeat across sections.

## Pending (user-requested, not yet built)

- Notebook sources column (`SourcesColumn.tsx`): search box + select-all + batch 'remove from notebook' (unlink only) button LEFT of the add-source button, mirroring the add-existing dialog. If a physical delete is ever offered in bulk, it must be single-item with explicit confirmation — never batch, never for external originals.
- User's workflow target: inside '添加现有来源', search a path keyword → select all → add in one shot (already built); the sources column should mirror that for removal.
