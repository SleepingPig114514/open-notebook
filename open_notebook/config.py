import os

# ROOT DATA FOLDER
DATA_FOLDER = "./data"

# LANGGRAPH CHECKPOINT FILE
sqlite_folder = f"{DATA_FOLDER}/sqlite-db"
os.makedirs(sqlite_folder, exist_ok=True)
LANGGRAPH_CHECKPOINT_FILE = f"{sqlite_folder}/checkpoints.sqlite"

# UPLOADS FOLDER
UPLOADS_FOLDER = f"{DATA_FOLDER}/uploads"
os.makedirs(UPLOADS_FOLDER, exist_ok=True)

# PODCASTS FOLDER
# Matches the root that build_episode_output_dir() (commands/podcast_commands.py)
# creates episode directories under when called with DATA_FOLDER in production.
PODCASTS_FOLDER = f"{DATA_FOLDER}/podcasts"
os.makedirs(PODCASTS_FOLDER, exist_ok=True)

# TIKTOKEN CACHE FOLDER
# Reads TIKTOKEN_CACHE_DIR from the environment so Docker can redirect the cache
# to a path outside /data/ (which is typically volume-mounted and would hide the
# pre-baked encoding baked into the image at build time).
TIKTOKEN_CACHE_DIR = os.environ.get("TIKTOKEN_CACHE_DIR", "").strip() or f"{DATA_FOLDER}/tiktoken-cache"
os.makedirs(TIKTOKEN_CACHE_DIR, exist_ok=True)

# LLM REQUEST TIMEOUT
# Wall-clock budget for a single provider chat call (seconds). Without it the
# OpenAI SDK's ~600s default + automatic retries let oversized contexts hang
# the chat endpoint until the frontend proxy dies with an opaque 500.
# Keep it below the frontend axios timeout (NEXT_PUBLIC_API_TIMEOUT_MS,
# default 600s) so the server always answers first. 0 disables it.
LLM_TIMEOUT_SECONDS = float(os.environ.get("OPEN_NOTEBOOK_LLM_TIMEOUT_SECONDS", "300") or 0)

# HTTP watchdog for POST /chat/execute (notebook chat): must exceed
# LLM_TIMEOUT_SECONDS so the inner model timeout surfaces first with its
# detailed message. Only active when LLM_TIMEOUT_SECONDS is set. Source chat
# and single-source ask get the model-level timeout above but no route-level
# watchdog; podcasts have their own async job pipeline.
CHAT_REQUEST_WATCHDOG_SECONDS = LLM_TIMEOUT_SECONDS + 60 if LLM_TIMEOUT_SECONDS > 0 else 0
