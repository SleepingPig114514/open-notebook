"""Folder import service: scan a local directory and reconcile it as Sources.

Calling the import twice with the same path is a sync:
- new files      -> create source + queue processing
- changed files  -> delete old source, recreate (insights are dropped)
- deleted files  -> delete their sources
- unchanged      -> skipped

The imported files stay in place; the Source's asset.file_path points at the
original file (unlike the /sources upload path, no LFI uploads-folder
restriction applies because the caller explicitly chooses the folder).
"""

import asyncio
import functools
import os
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, TypeVar

from loguru import logger

T = TypeVar("T")


async def _tx_retry(
    fn: Callable[[], Awaitable[T]],
    what: str,
    max_attempts: int = 10,
) -> T:
    """Retry on SurrealDB v2 read/write transaction conflicts.

    These conflicts are expected when the worker processes freshly submitted
    sources while the API keeps creating more (same tables); surreal-commands
    jobs use the same strategy (15 attempts). Only conflict errors are retried;
    anything else propagates immediately.
    """
    for attempt in range(1, max_attempts + 1):
        try:
            return await fn()
        except Exception as e:
            msg = str(e)
            if "conflict" not in msg or attempt == max_attempts:
                raise
            delay = min(0.2 * (2 ** (attempt - 1)), 3.0) + random.uniform(0, 0.15)
            logger.debug(
                f"Transaction conflict during {what} (attempt {attempt}); "
                f"retrying in {delay:.2f}s"
            )
            await asyncio.sleep(delay)
    raise RuntimeError("unreachable")

from open_notebook.database.repository import ensure_record_id, repo_query
from open_notebook.domain.notebook import Asset, Notebook, Source

# Directories that are never imported, regardless of where they appear.
SKIP_DIR_NAMES = {
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".idea",
    ".vscode",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}

# Extensions content-core can typically extract. Kept permissive: content-core
# itself does a header-based support check at processing time, so an odd file
# here simply fails its individual job instead of breaking the whole import.
SUPPORTED_SUFFIXES = {
    ".txt",
    ".md",
    ".markdown",
    ".pdf",
    ".docx",
    ".doc",
    ".pptx",
    ".ppt",
    ".xlsx",
    ".csv",
    ".html",
    ".htm",
    ".epub",
    ".rtf",
    ".json",
    ".xml",
}

MAX_FILES = 5000


@dataclass
class FolderImportResult:
    folder: str
    added: List[str] = field(default_factory=list)
    updated: List[str] = field(default_factory=list)
    deleted: List[str] = field(default_factory=list)
    unchanged: List[str] = field(default_factory=list)
    unsupported: List[str] = field(default_factory=list)

    def summary(self) -> Dict[str, Any]:
        return {
            "folder": self.folder,
            "added": len(self.added),
            "updated": len(self.updated),
            "deleted": len(self.deleted),
            "unchanged": len(self.unchanged),
            "unsupported": len(self.unsupported),
            "details": {
                "added": self.added,
                "updated": self.updated,
                "deleted": self.deleted,
                "unsupported": self.unsupported,
            },
        }


def _scan_folder(folder: Path, recursive: bool) -> List[Path]:
    """Return candidate files under folder, skipping hidden/junk dirs."""
    files: List[Path] = []
    iterator = os.walk(folder)
    for dirpath, dirnames, filenames in iterator:
        # Prune skipped and hidden directories in-place.
        dirnames[:] = [
            d
            for d in dirnames
            if d not in SKIP_DIR_NAMES and not d.startswith(".")
        ]
        for name in filenames:
            if name.startswith("."):
                continue
            files.append(Path(dirpath) / name)
        if not recursive:
            break
    return files


async def _load_existing_sources(
    folder_resolved: Path,
) -> Dict[str, Source]:
    """Map absolute file path -> Source for sources imported from this folder."""
    rows = await repo_query(
        "SELECT * FROM source WHERE asset.file_path != NONE "
        "AND string::starts_with(asset.file_path, $prefix)",
        {"prefix": str(folder_resolved) + os.sep},
    )
    result: Dict[str, Source] = {}
    for row in rows:
        source = Source(**row)
        if source.asset and source.asset.file_path:
            result[os.path.normcase(os.path.realpath(source.asset.file_path))] = source
    return result


async def _create_source_for_file(
    file_path: Path,
    folder: Path,
    notebook_ids: List[str],
    embed: bool,
) -> str:
    """Create the Source record and queue its processing job. Returns source id."""
    rel = file_path.relative_to(folder)
    rel_posix = rel.as_posix()
    # Path structure preserved in title; subdirectory names become topics.
    topics = list(rel.parts[:-1])

    source = Source(
        title=rel_posix,
        topics=topics,
        asset=Asset(file_path=str(file_path)),
    )
    await _tx_retry(source.save, f"create source {rel_posix}")

    for notebook_id in notebook_ids:
        await _tx_retry(
            functools.partial(source.add_to_notebook, notebook_id),
            f"link {rel_posix} to notebook",
        )

    # Local import to avoid pulling command registration into module import.
    from api.command_service import CommandService
    from commands.source_commands import SourceProcessingInput

    content_state: Dict[str, Any] = {
        "file_path": str(file_path),
        "delete_source": False,
    }
    command_input = SourceProcessingInput(
        source_id=str(source.id),
        content_state=content_state,
        notebook_ids=notebook_ids,
        transformations=[],
        # Default transformations are applied via the UI path; folder imports
        # keep it simple and explicit — no transformations in v1.
        embed=embed,
    )
    command_id = await _tx_retry(
        lambda: CommandService.submit_command_job(
            "open_notebook",
            "process_source",
            command_input.model_dump(),
        ),
        f"queue processing {rel_posix}",
    )
    source.command = ensure_record_id(command_id)
    # Keep the path-derived title: save_source only replaces placeholder
    # titles, and ours is already meaningful.
    await _tx_retry(source.save, f"stamp command on {rel_posix}")
    return str(source.id)


async def import_folder(
    path: str,
    notebook_ids: List[str],
    embed: bool,
    recursive: bool = True,
) -> FolderImportResult:
    folder = Path(path).expanduser().resolve()
    if not folder.exists() or not folder.is_dir():
        raise FileNotFoundError(f"Folder not found or not a directory: {path}")

    for notebook_id in notebook_ids:
        notebook = await Notebook.get(notebook_id)
        if not notebook:
            raise ValueError(f"Notebook {notebook_id} not found")

    scanned = _scan_folder(folder, recursive)
    if len(scanned) > MAX_FILES:
        raise ValueError(
            f"Too many files ({len(scanned)} > {MAX_FILES}); "
            "pick a narrower folder."
        )

    result = FolderImportResult(folder=str(folder))
    eligible: List[Path] = []
    for f in scanned:
        if f.suffix.lower() in SUPPORTED_SUFFIXES:
            eligible.append(f)
        else:
            result.unsupported.append(f.relative_to(folder).as_posix())

    existing = await _load_existing_sources(folder)
    seen_keys: set[str] = set()

    for file_path in eligible:
        key = os.path.normcase(os.path.realpath(str(file_path)))
        seen_keys.add(key)
        rel_posix = file_path.relative_to(folder).as_posix()
        old = existing.get(key)

        if old is None:
            source_id = await _create_source_for_file(
                file_path, folder, notebook_ids, embed
            )
            logger.info(f"Folder import: added {rel_posix} -> {source_id}")
            result.added.append(rel_posix)
            continue

        # Changed? Compare mtime_ns + size against the source's updated stamp
        # is unreliable (updated changes on saves); use file stat only. We
        # record the source's current updated time as the last-seen marker via
        # stat: simplest robust rule is stat change vs nothing — therefore
        # compare against a marker file sidecar would be overkill. We treat a
        # source as changed when the file mtime is newer than source.updated.
        try:
            stat = file_path.stat()
            changed = True
            if old.updated is not None:
                changed = stat.st_mtime > old.updated.timestamp() + 1
        except OSError:
            changed = False

        if changed:
            await _tx_retry(old.delete, f"delete old source {rel_posix}")
            source_id = await _create_source_for_file(
                file_path, folder, notebook_ids, embed
            )
            logger.info(f"Folder import: updated {rel_posix} -> {source_id}")
            result.updated.append(rel_posix)
        else:
            result.unchanged.append(rel_posix)

    # Files gone from disk -> delete their sources.
    for key, source in existing.items():
        if key not in seen_keys:
            if source.asset and source.asset.file_path:
                rel = os.path.relpath(source.asset.file_path, folder).replace(
                    os.sep, "/"
                )
            else:
                rel = str(source.id)
            await _tx_retry(source.delete, f"delete source {rel}")
            logger.info(f"Folder import: deleted {rel} ({source.id})")
            result.deleted.append(rel)

    return result
