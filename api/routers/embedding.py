from fastapi import APIRouter, HTTPException
from loguru import logger

from api.command_service import CommandService
from api.models import (
    EmbedActiveStatusRequest,
    EmbedActiveStatusResponse,
    EmbedCancelRequest,
    EmbedCancelResponse,
    EmbedRequest,
    EmbedResponse,
)
from open_notebook.ai.models import model_manager
from open_notebook.database.repository import repo_query
from open_notebook.domain.notebook import Note, Source
from open_notebook.exceptions import (
    NotFoundError,
    OpenNotebookError,
)

router = APIRouter()


@router.post("/embed/cancel", response_model=EmbedCancelResponse)
async def cancel_embedding(cancel_request: EmbedCancelRequest):
    """Flag active vectorization jobs for a source as cancelled.

    Cooperative cancellation: running jobs check the flag between embedding
    batches and abort; queued jobs abort before touching existing embeddings.
    """
    try:
        source_id = cancel_request.item_id
        if ":" not in source_id:
            source_id = f"source:{source_id}"
        rows = await repo_query(
            "UPDATE command SET cancel_requested = true "
            "WHERE name = 'embed_source' AND status IN ['new', 'running'] "
            "AND args.source_id = $sid RETURN meta::id(id) AS cid",
            {"sid": source_id},
        )
        count = len(rows or [])
        logger.info(f"Cancelled {count} active embed_source job(s) for {source_id}")
        return EmbedCancelResponse(
            success=True,
            cancelled_commands=count,
            message=(
                f"Cancelled {count} active embedding job(s)"
                if count
                else "No active embedding jobs to cancel"
            ),
        )
    except Exception as e:
        logger.error(f"Error cancelling embeddings for {cancel_request.item_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Error cancelling embeddings: {str(e)}")


@router.post("/embed/active-status", response_model=EmbedActiveStatusResponse)
async def embed_active_status(status_request: EmbedActiveStatusRequest):
    """Report which of the given sources have vectorization jobs in flight.

    Lightweight batched poll endpoint for the sources list: returns the set
    of source IDs with an embed_source command still queued/running, plus
    whether cancellation has been requested for them.
    """
    try:
        ids = [
            sid if ":" in sid else f"source:{sid}"
            for sid in status_request.item_ids
        ]
        if not ids:
            return EmbedActiveStatusResponse(active_ids=[], cancel_requested_ids=[])
        rows = await repo_query(
            "SELECT args.source_id AS sid, status, cancel_requested FROM command "
            "WHERE name = 'embed_source' AND status IN ['new', 'running'] "
            "AND args.source_id IN $ids",
            {"ids": ids},
        )
        active: list[str] = []
        canceling: list[str] = []
        seen: set[str] = set()
        for row in rows or []:
            sid = row.get("sid")
            if not sid or sid in seen:
                continue
            seen.add(sid)
            active.append(sid)
            if row.get("cancel_requested"):
                canceling.append(sid)
        return EmbedActiveStatusResponse(active_ids=active, cancel_requested_ids=canceling)
    except Exception as e:
        logger.error(f"Error fetching embed active status: {e}")
        raise HTTPException(status_code=500, detail="Error fetching embedding status")


@router.post("/embed", response_model=EmbedResponse)
async def embed_content(embed_request: EmbedRequest):
    """Embed content for vector search."""
    try:
        # Check if embedding model is available
        if not await model_manager.get_embedding_model():
            raise HTTPException(
                status_code=400,
                detail="No embedding model configured. Please configure one in the Models section.",
            )

        item_id = embed_request.item_id
        item_type = embed_request.item_type.lower()

        # Validate item type
        if item_type not in ["source", "note"]:
            raise HTTPException(
                status_code=400, detail="Item type must be either 'source' or 'note'"
            )

        # Branch based on processing mode
        if embed_request.async_processing:
            # ASYNC PATH: Submit command for background processing
            logger.info(f"Using async processing for {item_type} {item_id}")

            try:
                # Import commands to ensure they're registered
                import commands.embedding_commands  # noqa: F401

                # Submit type-specific command
                if item_type == "source":
                    command_name = "embed_source"
                    command_input = {"source_id": item_id}
                else:  # note
                    command_name = "embed_note"
                    command_input = {"note_id": item_id}

                command_id = await CommandService.submit_command_job(
                    "open_notebook",
                    command_name,
                    command_input,
                )

                logger.info(f"Submitted async {command_name} command: {command_id}")

                return EmbedResponse(
                    success=True,
                    message="Embedding queued for background processing",
                    item_id=item_id,
                    item_type=item_type,
                    command_id=command_id,
                )

            except Exception as e:
                logger.error(f"Failed to submit async embedding command: {e}")
                raise HTTPException(
                    status_code=500, detail=f"Failed to queue embedding: {str(e)}"
                )

        else:
            # DOMAIN MODEL PATH: Submit job via domain model convenience methods
            # These methods internally call submit_command() - still fire-and-forget
            logger.info(f"Using domain model path for {item_type} {item_id}")

            command_id = None

            # Get the item and submit embedding job
            if item_type == "source":
                source_item = await Source.get(item_id)

                # Submit embed_source job (returns command_id for tracking)
                command_id = await source_item.vectorize()
                message = "Source embedding job submitted"

            elif item_type == "note":
                note_item = await Note.get(item_id)

                # Note.save() internally submits embed_note command and
                # returns command_id. Unlike Source.vectorize(), save()'s
                # embed submission is best-effort (a hiccup there shouldn't
                # fail an otherwise-successful note save) - but this
                # endpoint's whole point is submitting the embedding job,
                # so a submission failure here (content present, no
                # command_id) must still surface as a failure.
                command_id = await note_item.save()
                if not command_id and note_item.content and note_item.content.strip():
                    raise HTTPException(
                        status_code=500, detail="Failed to submit note embedding job"
                    )
                message = "Note embedding job submitted"

            return EmbedResponse(
                success=True,
                message=message,
                item_id=item_id,
                item_type=item_type,
                command_id=command_id,
            )

    except HTTPException:
        raise
    except NotFoundError:
        raise HTTPException(
            status_code=404, detail=f"{embed_request.item_type} not found"
        )
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(
            f"Error embedding {embed_request.item_type} {embed_request.item_id}: {str(e)}"
        )
        raise HTTPException(
            status_code=500, detail=f"Error embedding content: {str(e)}"
        )
