# 本地定制改动说明（CHANGES.md）

本仓库为 [Open Notebook 官方原版（github.com/lfnovo/open-notebook）](https://github.com/lfnovo/open-notebook) 的**本地定制版**，基于官方 **v1.14.0（commit `3127f14`）**。本文件只说明与官方版本的差异；官方原版的功能介绍、安装与使用文档请见原仓库 README。

所有改动均为 Windows 原生部署 + 中文使用场景下的功能增强与安全修复，共 5 个板块、78 个代码文件（6 新增 + 72 修改）。详细实现清单与升级核查方法见 `docs/customizations/` 下三份维护手册。

> ⚠️ 使用本仓库代码时请先阅读「板块 2」中的删除安全门说明。

---

## 板块 1：模型推理档位控制（思考模式）

给所有语言模型调用增加"思考/推理强度"选择（默认 / 关闭 / low / medium / xhigh），UI 为统一的"模型 + 档位"下拉。档位按 **显式请求 > 会话/转换记录 > 默认槽位 > 不传参** 的优先级注入 `extra_body`（适配 DashScope 等 OpenAI 兼容端点的 `enable_thinking` / `reasoning_effort` 参数）。覆盖入口：默认模型设置（4 个语言槽位）、笔记本聊天、来源对话、Ask（三阶段独立档位）、转换编辑器与 Playground、CLI/来源自动转换。播客/TTS/STT 未接入（走直连路径）。

- 新增：`open_notebook/ai/thinking.py`（核心映射与注入）、`frontend/src/components/common/ModelPicker.tsx`（统一下拉组件）、`open_notebook/database/migrations/26.surrealql` + `26_down.surrealql`（`transformation.reasoning_level` 字段）、`tests/test_thinking_config.py`（21 用例）
- 修改：`open_notebook/ai/provision.py`、`open_notebook/graphs/{chat,source_chat,transformation,prompt,ask,source}.py`、`api/models.py`、`api/routers/{chat,source_chat,search,transformations,models}.py`、`open_notebook/domain/{notebook,transformation}.py`、`open_notebook/ai/models.py`、`commands/source_commands.py`；前端 `components/common/ModelSelector.tsx`、`components/sources/ModelSelector.tsx`（重写为 ModelPicker 薄包装）、`settings/DefaultModelSelectors.tsx`、`search/AdvancedModelsDialog.tsx`、`transformations/components/*`、`notebooks/components/ChatColumn.tsx`、`sources/ChatPanel.tsx`、`(dashboard)/search/page.tsx`、`(dashboard)/sources/[id]/page.tsx`、hooks `{use-ask,use-notebook-chat,use-source-chat}.ts`、types `{api,search,transformations,models}.ts`；i18n 14 语言
- 详见：`docs/customizations/reasoning-levels.md`

## 板块 2：文件夹导入 + 删除安全门（重要）

**文件夹导入（自研功能）**：`POST /api/sources/import-folder` 传入本地目录路径，文件**原地不动**（source 直接指向原始文件，不复制），支持递归与重复调用同步（新增/变更重建/缺失删除/未变跳过）。来源标题取相对路径结构、子目录段转为 topics，便于检索定位。前端"添加来源"对话框新增"导入文件夹"类型。

**删除安全门（修复官方数据安全隐患）**：官方 `Source.delete()` 对带文件的来源无条件 `os.unlink(file_path)`——对文件夹导入指向的外部原文件是毁灭性的（不进回收站）。本仓库改为**仅当文件位于 `data/uploads/` 内才删物理文件**，外部路径只删记录；`graphs/source.py` 的 `delete_source` 路径同样加守卫，并有回归测试覆盖。任何后续升级合并后必须重新核查这两处守卫。

- 新增：`api/folder_import_service.py`（含事务冲突重试、扩展名白名单、隐藏/垃圾目录剪枝、上限 5000 文件）
- 修改：`api/routers/sources.py`（导入端点）、`open_notebook/domain/notebook.py`（删除守卫）、`open_notebook/graphs/source.py`（删除守卫）、前端 `AddSourceDialog.tsx`、`steps/SourceTypeStep.tsx`；`tests/test_domain.py`（守卫回归用例）
- 详见：`docs/customizations/sources-api.md`

## 板块 3：向量化（embedding）链路修复与增强

1. **批量上限修复**：兼容端点（如 DashScope embedding）单请求批量上限 20~25 条，官方默认 50 导致向量化确定性失败。`open_notebook/utils/embedding.py` 的批量大小改由环境变量 `OPEN_NOTEBOOK_EMBEDDING_BATCH_SIZE` 控制（建议设为 10，`.env` 不入库）。
2. **rebuild 新增 missing 模式**：只重建"有正文但无向量"的条目，不影响已有向量；前端重建对话框默认选中该模式。
3. **协作式取消 + 进行中状态**：`POST /api/embed/cancel` 与 `POST /api/embed/active-status` 两个新端点；worker 在每个 batch 边界检查取消标志（`EmbeddingCancelledError`），排队任务被停时不先删旧向量；来源列表显示"向量化中/正在停止"徽标，支持行内与批量停止按钮，有任务在跑时前端 10s 轮询。
4. **服务端 embedded 筛选**：`GET /sources` 支持 `embedded=true|false` 查询参数，配合无限滚动分页。

- 修改：`open_notebook/utils/embedding.py`、`commands/embedding_commands.py`、`api/routers/{embedding,embedding_rebuild,sources}.py`、`api/models.py`、`frontend/src/app/(dashboard)/advanced/components/RebuildEmbeddings.tsx`、`frontend/src/lib/api/embedding.ts`、`frontend/src/lib/api/sources.ts`、`frontend/src/lib/types/api.ts`、`tests/test_embedding.py`
- 详见：`docs/customizations/embedding-maintenance.md`

## 板块 4：来源列表与批量操作 UX（中文界面）

- **来源管理页重写**（`(dashboard)/sources/page.tsx`）：无限滚动加载、向量化状态筛选下拉、全选仅选当前筛选结果、工具栏批量"向量化所选"/"停止向量化"（确认对话框）、行勾选框常显。
- **批量 hook**（`lib/hooks/use-sources.ts`）：`useBulkEmbedSources` 等，受限并发（最多 4）逐个调用再统一刷新——SurrealDB 无连接池，全并发批量写会产生事务竞争导致"接口全 200 但记录残留"。
- **"添加现有来源"对话框重写**（`AddExistingSourceDialog.tsx`）：改为客户端关键词子串匹配（标题/路径/topics/URL，官方版走语义搜索不匹配标题）+ 分页拉全量（官方版止步 100 条）+ 全选筛选结果。
- **笔记本来源列批量操作**（`notebooks/components/SourcesColumn.tsx`）：搜索框、全选、批量"从笔记本移除"（unlink）与"从来源中移除"。
- **删除文案安全约定（硬性规则）**：物理删除入口一律命名"从来源中移除"，确认文案必须写明磁盘文件不会被删除；批量操作绝不物理删除外部原文件。
- 修改另含：`SourceCard.tsx`、`SourceDetailContent.tsx`、`AddExistingSourceDialog.test.tsx`；i18n 14 语言。

## 板块 5：版本检查改走 GitHub Releases API

`open_notebook/utils/version_utils.py` 原版通过 `raw.githubusercontent.com` 抓取 `pyproject.toml` 解析版本号，在中国大陆网络下不可靠。改为请求 `api.github.com/repos/{owner}/{repo}/releases/latest` 并解析 `tag_name`，API/Worker 内的版本检查结果按内存缓存 24 小时。

- 修改：`open_notebook/utils/version_utils.py`、`tests/test_models_api.py`

---

## 随附文档

| 文件 | 内容 |
|---|---|
| `docs/customizations/reasoning-levels.md` | 板块 1 完整实现清单、参数映射实测、升级 reapply 指引 |
| `docs/customizations/sources-api.md` | 板块 2/4 的来源 API 事实、文件夹导入设计、删除安全门与陷阱记录 |
| `docs/customizations/embedding-maintenance.md` | 板块 3 全部修复的逐文件清单与升级核查清单 |

## 升级（git pull 上游）须知

1. 上游常改文件与本地改动高度重叠：`provision.py`、`api/models.py`、五个路由、五个 graph、两个域模型；pull 后按三份手册逐项核对。
2. **删除安全门必须重新核查**（板块 2），这是唯一涉及数据损毁风险的守卫。
3. 迁移编号 26 若被上游占用，将 `26*.surrealql` 重命名为下一个空闲编号（内容幂等）。
4. i18n 新增 key 覆盖全部 14 个语言文件，parity 测试会强制检查。
5. `.env`（数据库地址、加密密钥、`OPEN_NOTEBOOK_EMBEDDING_BATCH_SIZE=10` 等）不入库，换机时需自行配置，参见根目录 `.env.example`。

## 许可证

沿用官方 MIT License（见 `LICENSE`，版权归 Luis Novo）。
