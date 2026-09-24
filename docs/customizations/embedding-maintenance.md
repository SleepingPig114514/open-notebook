# 向量化（embedding）维护笔记

记录本机对向量化链路的修复与自研功能，供上游升级后核查。日期：2026-09-22。

## 背景问题

DashScope 兼容端点的 embedding（qwen3.7-text-embedding-flash）单请求批量上限为
20~25 条，而 Open Notebook 默认 `EMBEDDING_BATCH_SIZE=50`，导致 chunk 数 >25 的
来源全部向量化失败（重试也失败，因为错误是确定性的）。

## 修复 1：批量上限配置（非代码）

- `open-notebook/.env` 追加：`OPEN_NOTEBOOK_EMBEDDING_BATCH_SIZE=10`
- 生效位置：`open_notebook/utils/embedding.py` 读环境变量（上游代码自带该开关）。
- 修改后需**完全重启**（托盘退出再双击 VBS）：Worker 在启动时快照环境变量。
- 排查特征：worker.log 中 `batch size is invalid, it should not be larger than 25`。

## 修复 2：rebuild 新增 "missing" 模式（自研，侵入核心）

只重建"有正文但没有向量"的条目（failed/skipped 的 embed 作业），不影响已有向量。

| 文件 | 改动 |
|---|---|
| `commands/embedding_commands.py` | `RebuildEmbeddingsInput.mode` 枚举 +`missing`；`collect_items_for_rebuild` 三个分支各加 missing 查询（sources 用子查询 `count(SELECT ... FROM source_embedding WHERE source=$parent.id)=0`；notes/insights 用 `embedding=none OR array::len(embedding)=0`） |
| `api/models.py` | `RebuildRequest.mode` 枚举 +`missing` |
| `api/routers/embedding_rebuild.py` | 估算计数加 missing 分支 |
| `frontend/.../RebuildEmbeddings.tsx` | 下拉加"仅缺失项"选项（默认选中） |
| `frontend/src/lib/api/embedding.ts` | mode 类型 +`missing` |

## 修复 3：来源列表批量重新向量化（自研）

- `frontend/src/lib/hooks/use-sources.ts`：新增 `useBulkEmbedSources`，
  bounded 并发（BULK_CONCURRENCY=4）逐个 POST `/api/embed`，全部完成后再统一
  invalidate + toast（遵守"批量写禁止全并发"规则）。
- `frontend/src/app/(dashboard)/sources/page.tsx`：工具栏新增"向量化所选 N 项"
  按钮 + ConfirmDialog。
- 单条重跑入口（stock 功能，文案已本地化）：来源详情 →「⋮」→"向量化内容"。

## 修复 4：来源列表"向量化状态"筛选（自研，2026-09-22 追加）

- `api/routers/sources.py`：`GET /sources` 新增 `embedded=true|false` 查询参数
  （服务端过滤，配合无限滚动分页；SurrealQL 形式 `WHERE true AND
  (SELECT VALUE id FROM source_embedding WHERE source=$parent.id LIMIT 1) = []`）。
- `frontend/src/lib/api/sources.ts`：list params 加 `embedded`。
- `frontend/src/app/(dashboard)/sources/page.tsx`：工具栏下拉筛选
  （全部/未向量化/已向量化，走服务端），筛选后"全选"只选当前筛选结果，
  可直接"向量化所选 N 项"批量补跑。
- i18n keys：`sources.embedFilterLabel/All/Missing/Embedded` ×14。

## 修复 5：向量化"进行中"状态显示 + 用户可停止（自研，2026-09-22 追加）

列表行现在能区分 未向量化 / 向量化中 / 取消中 / 已向量化，并可停止在跑的任务。

- 取消机制为**协作式**（surreal-commands 无原生 cancel，worker 执行中不复查状态）：
  - `open_notebook/utils/embedding.py`：新增 `EmbeddingCancelledError` 与
    `command_cancel_requested()`；`generate_embeddings` 每个 batch 边界检查一次
    `command.cancel_requested` 标志，置位则抛异常终止。
  - `commands/embedding_commands.py`：`embed_source` 开头加早退检查（排队中的
    任务被停时不会先删旧向量）；`EMBED_RETRY_CONFIG.stop_on` 加入
    `EmbeddingCancelledError`（取消不重试）。
  - `api/routers/embedding.py`：`POST /api/embed/cancel`（UPDATE 活跃
    embed_source 命令置 cancel_requested=true）、
    `POST /api/embed/active-status`（批量查哪些 source 有在跑的任务，供前端轮询）。
  - 取消后的命令终态是 `failed` + error_message "Embedding cancelled by user"
    （不是 canceled 状态；worker 抛异常路径所致，属预期）。
- `api/routers/sources.py`：列表查询加 `embedding_active` /
  `embedding_cancel_requested` 两个 GROUP ALL 子查询投影（实测
  `args.source_id = type::string($parent.id)` 需配 GROUP ALL 才返回标量）。
- `frontend/src/app/(dashboard)/sources/page.tsx`：
  - "已向量化"列：active 时显示蓝色"向量化中"徽标（amber"正在停止..."），
    否则维持 是/否。
  - 行内停止按钮（Square 图标，仅 active 行显示）；工具栏批量"停止向量化"按钮
    （选中项含 active 时出现）+ ConfirmDialog。
  - 有 active 徽标时每 10s 轮询 active-status 就地更新行状态，全部结束后
    触发一次列表 refetch 同步 embedded 标志（避免整表反复重置打断无限滚动）。
- 已嵌入文档可通过批量/单条"向量化所选"重跑：embed_source 先删旧向量再重建，
  幂等（`useBulkEmbedSources` 注释已说明）。
- 已端到端验证：提交→active=true→cancel→worker 在第 24/67 批停止→徽标清除。

## 取消后台任务的方法（通用，surreal-commands 无 cancel API）

向量化任务请用网页上的停止按钮（走上面的协作式取消）。其他类型任务
（如 source_process PDF 解析，无批间检查点）仍需手动：先
`UPDATE type::record($cid) SET status='canceled'`（防止重启后重新执行 new
状态命令），再杀 worker 进程终止正在跑的任务。托盘"重启全部服务"会拉起新
worker，其启动时只领取 status='new' 的命令。

## i18n

14 个语言文件新增 keys：`sources.bulkEmbedInProgress/bulkEmbedSelected/
bulkEmbedConfirmTitle/bulkEmbedConfirmDesc/bulkEmbedQueuedSuccess` 与
`advanced.rebuild.missing/missingDesc`；zh-CN 将"嵌入"系列文案统一改为"向量化"
（键名不变，仍为 embedContent/alreadyEmbedded 等 stock 键）。parity 测试通过。
修复 5 追加 keys ×14：`sources.embeddingInProgress/embeddingCanceling/
stopEmbedTooltip/bulkStopEmbedSelected/bulkStopEmbedConfirmTitle/
bulkStopEmbedConfirmDesc/embedCancelSuccess/embedCancelFailed`。

## 升级核查清单（每次 git pull 后）

1. 上述代码文件（embedding.py 工具、embedding_commands.py、api/routers/
   embedding.py、api/routers/sources.py、api/models.py、sources/page.tsx、
   use-sources.ts、embedding.ts、types/api.ts、RebuildEmbeddings.tsx）是否与
   上游冲突；missing 模式、批量 hook、协作式取消逻辑是否保留。
2. `.env` 中 `OPEN_NOTEBOOK_EMBEDDING_BATCH_SIZE=10` 是否还在（.env 不受 git 影响，
   但换机/重建时易丢）。
3. `tests/test_embedding.py::test_batching` 已改为跟随 EMBEDDING_BATCH_SIZE 常量，
   若上游回退为硬编码 50 会与本配置冲突（表现为测试失败，属预期提醒）。

## 剩余 4 个失败来源（非批量问题）

| 来源 | 原因 | 处理 |
|---|---|---|
| 赏延素心录.doc | 旧二进制 .doc 不被解析器支持 | 转 .docx/PDF 后重新导入 |
| 修复文物清单.docx | 磁盘文件为 0 字节 | 找回原件 |
| 装潢志.pdf / 书画的装裱与修复_可搜索版.pdf | Docling 拉 HF 模型时网络失败 | retry 端点重跑（2026-09-22 已触发，验证结果见会话记录） |
