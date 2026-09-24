# 推理档位（思考控制）维护手册

本机自研功能：给 Open Notebook 的所有语言模型调用增加"思考/推理强度"控制，UI 参考 Hermes 的统一下拉模式（触发框显示 `模型名 · 档位`）。基线版本 v1.14.0（commit 3127f14）。

## 1. 入口覆盖与档位归属

| 入口 | 档位存储位置 | 说明 |
|---|---|---|
| Settings → 默认模型分配（4 个语言槽位） | `default_models.model_args`（JSON，按槽位键控） | Batch 1；TTS/STT/嵌入槽位不带档位 |
| 笔记本聊天·临时手选模型 | 会话级 `chat_session.reasoning_level` + 单次请求字段 | 请求级优先于会话级 |
| 来源对话 | 同上（复用 ChatSession 记录） | sources/ModelSelector 接入 |
| Ask（搜索页高级模型） | 请求级三字段，三个阶段各自独立 | `strategy/answer/final_answer_reasoning_level` |
| 转换 Playground | 单次执行请求字段 | 不落库 |
| 转换编辑器 | `transformation.reasoning_level`（持久化，迁移 26） | 执行优先级：单次运行 > 记录 > 槽位 |
| CLI / 来源自动转换 | 跟随转换记录 | `commands/source_commands.py`、`graphs/source.py` 透传 |

统一规则（`provision.py` 实现）：**显式请求档位 > 会话/记录档位 > 默认槽位档位 > 不传参数**。非法值 API 层 422 拒绝；provision 层防御性忽略并回退槽位值。手选模型且未选档位时不传任何参数（不误用槽位值——档位属于选择动作本身）。

## 2. 参数映射（百炼 DashScope 兼容模式实测）

| 档位 | extra_body |
|---|---|
| 默认（跟随模型） | 不传 |
| 关闭 | `{"enable_thinking": false}` |
| low / medium / xhigh | `{"enable_thinking": true, "reasoning_effort": "<档位>"}` |

- qwen3.7/3.8 系列实际支持 low/medium/xhigh 三档；下拉只放模型真实支持的值，不照抄 Hermes 的 7 档抽象。
- `thinking_budget` 未实现：与 `reasoning_effort` 互斥，需要时再加。
- 实测（qwen3.8-flash，用户 MaaS 端点）：默认 1.1s/28 reasoning tokens；关闭 0.6s/0；low 2.2s/31。该端点 `enable_thinking=false` 真实生效（部分百炼端点是伪开关，换新端点需重测）。

## 3. 实现清单（升级 reapply 用）

### 新增文件
| 文件 | 作用 |
|---|---|
| `open_notebook/ai/thinking.py` | 核心模块：`REASONING_LEVELS`、`build_reasoning_extra_body`、`apply_reasoning_level`、`get_slot_reasoning_level` |
| `frontend/src/components/common/ModelPicker.tsx` | 统一"模型+档位"下拉组件（Hermes 式弹层，分组：上模型/下档位） |
| `open_notebook/database/migrations/26.surrealql` / `26_down.surrealql` | `transformation.reasoning_level` 字段（`DEFINE/REMOVE FIELD IF EXISTS`） |
| `tests/test_thinking_config.py` | 21 个用例：参数映射、注入、槽位解析、显式优先级、Ask helper、转换校验 |

### 修改文件（仅推理档位功能，33 个中的其余为嵌入/文件夹导入等其它自研改动）
- 后端注入：`open_notebook/ai/provision.py`（`provision_langchain_model` 新增 `reasoning_level` 参数，`to_langchain()` 后按优先级注入 `extra_body`）
- graphs：`chat.py`、`source_chat.py`、`transformation.py`、`prompt.py`（读 `configurable.reasoning_level`）；`ask.py`（三个 `*_reasoning_level` 键）；`source.py`（transform_content 透传）
- API 请求/响应：`api/models.py`（AskRequest、TransformationCreate/Update/ExecuteResponse 档位字段 + validator）
- 路由：`api/routers/chat.py`、`source_chat.py`（会话级字段 + 请求覆盖优先级 + configurable 透传）、`search.py`（`_ask_reasoning_levels` helper，流式/非流式两端点）、`transformations.py`（create/update/execute + RunnableConfig）
- 域模型：`open_notebook/domain/transformation.py`、`notebook.py`（ChatSession/Transformation 增 `reasoning_level`，加入 `nullable_fields`）
- CLI：`commands/source_commands.py`
- 前端：`components/common/ModelSelector.tsx` 与 `components/sources/ModelSelector.tsx` 重写为 ModelPicker 薄包装（所有消费者自动获得档位选择）；`settings/DefaultModelSelectors.tsx`（Batch 1）；`AdvancedModelsDialog.tsx`、`search/page.tsx`、`ChatColumn.tsx`、`ChatPanel.tsx`、`sources/[id]/page.tsx`、`TransformationPlayground.tsx`、`TransformationEditorDialog.tsx`；hooks `use-ask.ts`/`use-notebook-chat.ts`/`use-source-chat.ts`；types `api.ts`/`search.ts`/`transformations.ts`/`models.ts`
- i18n：14 个语言文件（档位组标题/说明/各档位文案；同时清理了旧选择器的 5 个孤儿 key）

## 4. 验证方法

```bash
# 后端（在内层目录）
uv run pytest tests/test_thinking_config.py -q     # 21 passed
uv run pytest tests/ -q                             # 全量；Windows 基线固有 4 失败（播客路径/代理 env 大小写）与本功能无关

# 前端（在 frontend/）
npx tsc --noEmit
npx eslint <改动文件>
npx vitest run src/lib/locales/index.test.ts        # 27 passed（parity）

# 迁移语法（可选，临时实例）
surreal start --bind 127.0.0.1:8001 --user test --pass test memory
curl -s -u test:test --data "USE NS test DB test; <迁移内容>" http://127.0.0.1:8001/sql
```

端到端冒烟：起临时 API 实例（别动 5055 正式实例），PUT/GET `default_models.model_args` 验证 422 校验；`provision_langchain_model` 传不同 `reasoning_level` 检查返回模型的 `extra_body`。

## 5. 升级（git pull）注意事项

1. **冲突面**：`provision.py`、`api/models.py`、五个路由、五个 graph、两个域模型是上游常改文件；pull 后逐个检查本手册第 3 节清单是否还在（`grep -rn reasoning_level api open_notebook commands`）。
2. **迁移编号**：若上游占用了 26，把 `26*.surrealql` 重命名为下一个空闲编号（内容 `IF EXISTS` 幂等，无需改文）。
3. **i18n**：上游语言文件变动后重跑 parity 测试，按报错补齐缺失 key（14 语言全覆盖）。
4. **删除安全门**：与本手册无关，但升级后必须一并核查 `docs/sources-api.md` 的守卫。
5. `chat_session` 表 SCHEMALESS，会话级字段免迁移；`transformation` 表有 schema，必须靠迁移 26。

## 6. 已知边界

- **播客 / TTS / STT**：按需求跳过。播客走 `_resolve_model_config` 直连 Esperanto，不经 LangChain。
- **"测试模型"按钮**：测原始连通性，非下拉菜单，保持现状。注意 `enable_thinking=true` 对部分模型要求流式，非流式测试可能报错——不代表配置无效。
- **Esperanto provider 限制**：`openai` provider 不透传 `extra_body`，仅 `openai_compatible`/`dashscope` 支持。LangChain 主链路（聊天/Ask/转换/来源对话）不受影响；若未来要覆盖播客/测试按钮直连路径，需把模型记录迁到 `openai_compatible`/`dashscope` provider（涉及用户凭据配置，须用户自行操作）。
- 生效需**重启全部服务**（托盘退出 → 重新双击 VBS）；API 与前端代码均有改动，热重载不覆盖全部进程。
