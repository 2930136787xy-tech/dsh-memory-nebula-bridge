# 记忆星云 · Memory Nebula（DSH 插件）

> **English**: Gives DeepSeek Harness its own memory. The plugin ships the memory-nebula runtime, scaffolds a private store on first run (`~/.dsh/memory-nebula`), serves the 3D star map as a local sidecar on `127.0.0.1`, and adds an **in-UI panel** (search, edit, importance, pin, forget/restore, batch merge) plus six agent tools — `nebula_status`, `nebula_recall`, `nebula_remember`, `nebula_search`, `nebula_mood`, `nebula_memory_update`. No chat app, no account, no data bundled. Requires Python 3.9+.

给 DeepSeek Harness 一份**属于使用者自己**的记忆：能想起来、能记住、能看见，不需要任何聊天软件。

- **零准备**：插件自带框架，第一次启动就在 `~/.dsh/memory-nebula` 建一份空库，数据全在本机；
- **侧栏面板**：左下角「记忆星云」按钮打开页面内面板——搜索、看正文、改正文、调重要度、置顶、忘掉/恢复、批量合并，右上角可跳完整三维星云；
- **会话工具**：六个智能体工具，让模型自己检索、写入、维护记忆，并读写心情；
- **本地 sidecar**：用 Python 拉起 `viewer_server.py`，只监听 `127.0.0.1`，随 DSH 一起退出；
- **不主动发言**：不推送消息、不打断对话，只在你或模型调用时读写记忆。

## 安装

```bash
dsh plugin add github:2930136787xy-tech/dsh-memory-nebula-bridge
# 或者用 Release 里的包（不需要 git）：
dsh plugin add https://github.com/2930136787xy-tech/dsh-memory-nebula-bridge/releases/download/v0.3.0/dsh-memory-nebula-bridge-0.3.0.tgz
```

装完在「插件」页确认已启用。左侧栏底部出现「记忆星云」按钮；若按钮没出现，刷新一次页面。

## 装完之后，DSH 会话里多了什么

### 面板（侧栏「记忆星云」）

| 能力 | 说明 |
|---|---|
| 三维星云 | 记忆/会话/日期/摘要/人格/核心六类球；球径是重要度，灰度是遗忘程度 |
| 搜索 | 关键词过滤，可只看永久、只看已遗忘 |
| 改单条 | 改正文、调重要度、置顶/取消、忘掉/恢复、删除 |
| 批量 | 多选合并、批量置顶、批量忘掉 |
| 打开完整页 | 跳转本机 `127.0.0.1:<端口>` 的三维页面 |

### 会话里的工具

| 工具 | 作用 | 典型触发 |
|---|---|---|
| `nebula_status` | 是否运行、库路径、记忆条数、心情 | 「你还记得多少」 |
| `nebula_recall` | 按相关度取回（重要度 + 新近度 + 永久 + 关键词加权） | 回答前先想起来 |
| `nebula_remember` | 写入一条记忆（自动去重，可设重要度/永久） | 「记住我喜欢…」 |
| `nebula_search` | 按关键词模糊匹配 | 精确找某句话 |
| `nebula_mood` | 读/写心情（效价、唤醒、亲近） | 「你现在心情如何」 |
| `nebula_memory_update` | important / less / pin / unpin / forget / restore / edit / delete / merge | 「把这条设成永久」 |

### 明确不做的

- **不会主动发言**：不推送消息、不插话；
- 不做多账号、不做远程访问，服务只绑 `127.0.0.1`。

## 前置条件

1. Python 3.9+（`py -3`、`python` 或 `python3` 任一可用）；
2. 想用自己的库就配 `config.dataDir`；不配则第一次启动自动在 `~/.dsh/memory-nebula` 建空库。

## 从零建自己的记忆库 / 导入已有记忆

```bash
# 建库（可指定人格；会复制一份完整框架到目标目录）
python framework/tools/init_store.py D:\my-memory --persona 10001=我自己 --admin 10001

# 导入任何来源的记忆（JSONL / JSON / CSV / 纯文本，自动去重）
python framework/tools/import_memories.py D:\my-memory --file notes.jsonl --conversation app:notes
```

然后把 `config.dataDir` 指向 `D:\my-memory`。

## 配置

数据目录按下面的顺序查找，第一个找到 `viewer_server.py` 的胜出：

1. `config.dataDir`（在自己的 profile patch 里覆盖）
2. 环境变量 `DSH_MEMORY_NEBULA_DIR`
3. `~/.dsh/memory-nebula`
4. `~/memory-nebula`
5. `~/Documents/memory-nebula`

都没有时，插件会用自带框架在 `~/.dsh/memory-nebula` 自动建库（`autoInit: false` 可关掉）。

```yaml
- id: dsh-memory-nebula-bridge
  name: 'dsh-memory-nebula-bridge'
  config:
    dataDir: 'D:/path/to/memory-nebula'
    python: 'py -3'      # 可选：显式指定解释器
    port: 8765           # 可选：侧车端口，默认自动挑空闲端口
    statusPort: 6183     # 可选：页面读状态的本地端口
    autoInit: true       # 可选：没有库时是否自动建一个
```

## 安全

- sidecar 只绑 `127.0.0.1`，不对外网开放；
- 插件包内不含任何真实记忆、账号或密钥，数据全部留在使用者自己的目录里；
- 星云页面的账号模式、只读模式仍由 memory-nebula 自己控制。

## 许可

MIT。