# 记忆星云 · Memory Nebula（DSH 插件）

> **English**: Bridges an existing memory-nebula project (`viewer_server.py` + `brain.db`/`bridge.db`) into DeepSeek Harness. It starts the viewer as a local sidecar on `127.0.0.1`, adds a **panel inside the DSH UI** (search memories, read one, edit its text, raise/lower importance, pin, forget/restore, jump to the full 3D graph), and registers three agent tools — `nebula_status`, `nebula_search`, `nebula_memory_update` — so the model can recall and curate memories. Requires Python 3.9+. No bundled data.

把「记忆星云」（memory-nebula）记忆库接进 DeepSeek Harness：

- **侧栏面板**：左下角「记忆星云」按钮打开**页面内面板**——搜索记忆、看正文、**编辑正文**、调重要度、设/取消永久、忘掉/恢复，面板右上角可跳转完整三维星云；
- **智能体工具**：`nebula_status`（状态）、`nebula_search`（按关键词检索记忆）、`nebula_memory_update`（pin / forget / restore / edit / delete / merge）；
- **本地 sidecar**：插件启动时用 Python 拉起 `viewer_server.py`，只监听 `127.0.0.1`，随 DSH 一起退出。

## 前置条件

1. Python 3.9+（`py -3`、`python` 或 `python3` 任一可用）；
2. 一份 memory-nebula 项目目录（含 `viewer_server.py`、`memory_view.py`、`web/`），里面有 `brain.db` 和/或 `bridge.db`。

## 快速试用（还没有记忆库）

在 memory-nebula 项目目录里生成一套虚构演示数据（四个虚构人物、两份库、26 条摘要）：

```bash
python demo/make_demo.py
```

它会在项目根目录生成 `data/`、`personas/`、`brain.db`、`bridge.db`、`config.json`（都在 `.gitignore` 里）。然后把 `config.dataDir` 指向这个目录即可——用的是虚构数据，不会碰到任何真实聊天记录。

## 配置

数据目录按下面的顺序查找，第一个找到 `viewer_server.py` 的胜出：

1. `config.dataDir`（在自己的 profile patch 里覆盖）
2. 环境变量 `DSH_MEMORY_NEBULA_DIR`
3. `~/.dsh/memory-nebula`
4. `~/memory-nebula`
5. `~/Documents/memory-nebula`

```yaml
- id: dsh-memory-nebula-bridge
  name: 'dsh-memory-nebula-bridge'
  config:
    dataDir: 'D:/path/to/memory-nebula'
    python: 'py -3'     # 可选：显式指定解释器
    port: 8765          # 可选：侧车端口，默认自动挑空闲端口
    statusPort: 6183    # 可选：页面读状态的本地端口
```

## 工具

| 工具 | 作用 |
|---|---|
| `nebula_status` | 是否运行、数据目录、访问地址、各类型节点计数 |
| `nebula_search` | 按关键词模糊匹配记忆正文，返回节点 id、正文、重要度、是否永久、状态 |
| `nebula_memory_update` | 对 `mem:<库>:<id>` 执行 important / less / pin / unpin / forget / restore / edit / delete / merge |

## 安全

- 侧车只绑 `127.0.0.1`，不对外网开放；
- 插件包内不含任何真实记忆、账号或密钥，数据全部留在你自己的目录里；
- 星云页面的账号模式、只读模式仍由 memory-nebula 自己控制。

## 许可

MIT。