# OpenCode V1 动态 MCP 桥接插件（1+N 架构）POC

验证 **OpenCode V1 插件**能否：

1. **动态添加 MCP server**（会话中途注册，下一步即对 LLM 可见）
2. **把动态 MCP 作为代理，桥接回主 MCP 的 `invoke` 元方法**（转发逻辑全部在插件层，对 Agent 透明）

目标宿主版本 **v1.2.27**（内网生产），兼容 **v1.19.5**（本地集成测试）。所有机制均已在两个版本的源码中逐项核验，无需修改 OpenCode 源码。

## 架构

```
                    ┌──────────── mock hub（无状态，多 Agent 并发共享）────────────┐
                    │  /mcp（Agent 面）          /exec/mcp（服务面）              │
Agent ── skills-hub_list-skill ──────────────────► │ list-skill  prepare-skill │ │ invoke ◄──┐
Agent ── skills-hub_prepare-skill ───────────────► └───────────────────────────┘           │
                    │ tool.execute.after（插件）                                          │
                    ├─ 解析 {ok, skillId, skillMd, mcpJson}                                │
                    ├─ client.mcp.add("skill-weather", {type:"remote",                     │
                    │    url:"http://127.0.0.1:<随机端口>/mcp/weather", oauth:false})       │
                    ├─ skills/sessions 表登记（易变状态全在插件内存）                        │
                    └─ 改写工具返回为短确认（SKILL.md 改走 system prompt 注入）              │
Agent ── skill-weather_get_weather（下一步即可见）──► 插件内 Bun.serve（stateless 代理）────┘
                              │ callTool → hubInvoke() → hub 的 /exec 面绕回 invoke
system prompt：experimental.chat.system.transform 按 session 注入 <skill_instructions>
```

- **主 MCP（skills hub）**：无状态、双端点分面。`/mcp` 只挂 `list-skill`/`prepare-skill`；`/exec/mcp` 只挂 `invoke` → **invoke 结构性隐藏**（Agent 面根本不存在，不依赖任何客户端隐藏配置）。`prepare-skill` 一次性自包含返回 SKILL.md + MCP.JSON。
- **动态 MCP（代理）**：插件进程内 `Bun.serve`，stateless Streamable HTTP（SDK 1.25.2 官方 stateless 模式；**该版本 stateful transport 单 session，无法承受重连/多客户端，这是实现期实测确认的关键点**）。`tools/list` 原样透传 MCP.JSON 的 JSON Schema（低层 `Server.setRequestHandler`，零转换）；`tools/call` 封装后经 `/exec` 面绕回 `invoke`。
- **状态分布**：hub 零状态；一切易变状态（已装配技能、session 引导记录）在每实例私有的插件内存中，随进程生灭。

## 目录

```
├── mock-hub/                        # 主 MCP 模拟器（独立进程，无状态，双端点）
│   ├── skills.ts                    #   weather 技能：SKILL.md / MCP.JSON / mock 执行器
│   └── hub.ts                       #   bun run mock-hub/hub.ts（默认 127.0.0.1:7777，HUB_PORT 覆盖）
├── tests/                           # bun test 单测（不依赖 OpenCode 宿主与 LLM）
│   ├── hub.test.ts                  #   双端点工具面隔离 + 三工具契约
│   ├── plugin.test.ts               #   after-hook 解析/注册/改写 + 防御性放行
│   └── proxy.test.ts                #   桥接闭环（真 MCP client → 代理 → hub.invoke）
└── demo/                            # OpenCode 工作区（1.2.27 为主、兼容 1.19.5）
    ├── opencode.json                #   hub Agent 面 remote 配置
    ├── AGENTS.md                    #   引导 Agent 走 list→prepare→用 skill-* 工具
    └── .opencode/
        ├── package.json             #   插件依赖 @modelcontextprotocol/sdk@1.25.2（宿主自动 bun install）
        └── plugins/dynamic-mcp.ts   #   插件本体（legacy 单函数导出）
```

## 快速开始（单测）

```bash
bun install
bun test          # 15 个用例：hub 契约 / 插件 hooks / 桥接闭环
```

注意：`demo/.opencode/package.json`（插件依赖声明）**不入库**——OpenCode 宿主会自己维护该目录的 `.gitignore` 并把它视为环境产物（首次运行会自动写入/补全）。全新 clone 后首次启动宿主前，需手工创建该文件：

```json
{
  "name": "opencode-dynamic-mcp-demo",
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.25.2"
  }
}
```

## 集成测试（OpenCode + 真实模型）

```bash
# 1. 起 mock hub
bun run hub        # [hub] skills-hub listening on http://127.0.0.1:7777/

# 2. 起 OpenCode，工作区指向 demo/（源码入口，版本按测试阶段选择）
cd demo && bun <OpenCode 源码>/packages/opencode/src/index.ts

# 3. TUI 对话验证
#    - "列出你能用的工具"：有 skills-hub_list-skill / skills-hub_prepare-skill，没有 skills-hub_invoke
#    - "帮我查北京的天气"：Agent 走 list → prepare → 调 skill-weather_get_weather → 回答 21℃ sunny
#    - hub 日志：[hub] agent list-skill / [hub] agent prepare-skill / [hub] exec invoke（invoke 只来自 exec 面）
#    - 插件日志：[dynamic-mcp] registered skill-weather ... / [dynamic-mcp] bridge weather/get_weather ...
```

⚠️ 不要使用全局安装的 opencode 二进制做本测试（本机为 v2.0.25，V2 架构与本项目无关）。

## 机制 → 源码映射（目标版本 1.2.27）

| 机制 | 源码位置（`packages/opencode/`） |
|---|---|
| `MCP.add(name, config)` 动态注册（内存态、立即连接、关旧连新） | `src/mcp/index.ts:294` |
| `POST /mcp` 端点 + SDK `client.mcp.add` | `src/server/routes/mcp.ts:32`、`packages/sdk/js/src/gen/sdk.gen.ts:944` |
| `tool.execute.after` 包装 MCP 工具；output 为原始 CallToolResult，`content` 在 trigger 后才消费 → 改写有效 | `src/session/prompt.ts:838-928` |
| `experimental.chat.system.transform`（含 sessionID） | `src/session/llm.ts:83` |
| 每步重解析工具（`MCP.tools()` 实时 listTools）→ 中途注册的 server 下一步可见 | `src/session/prompt.ts:606`、`src/mcp/index.ts:609` |
| 工具命名 `sanitize(server)_sanitize(tool)` | `src/mcp/index.ts:642` |
| remote transport（StreamableHTTP 优先、SSE 回退、`oauth:false`） | `src/mcp/index.ts:341` |
| `.opencode/package.json` 依赖自动安装 | `src/config/config.ts:274` |

## 跨版本兼容策略（1.2.27 ↔ 1.19.5，无需运行时版本判断）

「公共子集 + 优雅降级」，一份插件代码两版通用：

| 差异点 | 兼容做法 | 依据 |
|---|---|---|
| 插件文件格式 | **legacy 单函数导出**（唯一导出） | 1.2.27 遍历命名导出（`plugin/index.ts:84`）；1.19.5 `applyPlugin` 回退 `getLegacyPlugins`（`plugin/index.ts:114-125`） |
| SDK 依赖 | 锁 **1.25.2** | `WebStandardStreamableHTTPServerTransport` 在 1.25.2 存在；两版宿主 client 与之协议兼容 |
| Hooks | 只用两版都有的 `tool.execute.after` + `experimental.chat.system.transform`；额外携带 `dispose` | 1.19.5 触发清理、1.2.27 自然忽略（无此 hook 的多余 key 不触发不报错） |
| `client.mcp.add` | 两版均为 `POST /mcp`；响应形状 optional chaining 防御解析 | 两版 sdk.gen 均核验 |

若未来需要真分支：读宿主自动安装的 `@opencode-ai/plugin` 包 version（与宿主同版本号），或特性探测。

## 方案讨论决策记录

1. **零插件路线（hub 侧 tools/list_changed）否决**：要求 hub 维护 per-connection 可变工具表 = 有状态，多 Agent 并发下互相污染——与"hub 无状态、多 Agent 共享"的第一性约束冲突。
2. **invoke 形态：分面端点（形态 2）**。`/mcp` 只挂 list+prepare，`/exec/mcp` 只挂 invoke：结构性隐藏 + 保留统一执行咽喉（治理/审计/热更新）。备选：形态 1（共端点 + permission deny，隐藏依赖客户端配置）；形态 3（无 invoke，prepare 返回执行坐标+令牌、代理直连实际执行 server——要求实际服务客户端可达、治理下沉）。三种形态下 OpenCode 侧插件架构完全不变。
3. **session 级可见性（遗留项）**：v1.19.5 上已验证机制存在（session permission ruleset 可 API 写入、持久化、findLast 后写胜出），但受快照架构限制（prompt 循环只取一次 session 快照，after-hook 写入的 allow 对当前轮不生效）→「同轮可见 × 其他 session 严格不可见」不可兼得。三选一待定：A 严格隔离（两段式 UX）/ B 同轮可用 + before-hook 执行守卫 / C = A + 空闲自动续跑。**当前接受 instance 级可见**。
4. **无状态鉴权/归因（预留）**：prepare-skill 返回短时令牌，代理 invoke 时附带（`context` 字段或 exec 连接 header），hub JWT 式校验仍无状态。POC 未实现，invoke 契约已预留 `context` 字段。
5. **SKILL.md 不走工具返回**：after-hook 改写返回为短确认，SKILL.md 经 system.transform 注入（按 session、每请求现拼）——数据面与 Agent 可见面分离，同时截掉 Agent 不需要看的 mcpJson schema（工具注册后 schema 从正规 tools 数组获取，对话里那份纯属 token 冗余）。
6. **持久化**：`mcp.add` 内存态、重启即失（技能是会话级能力，可接受）。零配置接入可用插件 `config` hook 注入 hub 配置（未实现）。
7. **stdio 代理变体（transport 层回退）**：`{type:"local", command:[bun, proxy-stdio.ts, skillId, execUrl]}`，每技能一子进程；仅当 HTTP 代理出现不可解的兼容问题时启用。

## 已知边界

- 动态 MCP 是 **instance 级**：同实例所有 session 共享（含子代理 session）；跨实例/跨 Agent 天然隔离。
- 插件在 1.2.27 上无 `dispose` 清理，代理端口与 exec 连接随宿主进程消亡。
- `MCP.add` 后 `connect()` 找不到动态 server（1.2.27 的 `add` 不写 config 状态）；重连走重复 `add`（关旧连新，幂等）。
- **内网迁移注意**：`demo/.opencode` 与 `mock-hub` 的 `@modelcontextprotocol/sdk@1.25.2` 安装需离线可用——最稳妥是直接把 `demo/.opencode/node_modules` 整体 vendor 随仓库目录带入（并按上文手工确保 `.opencode/package.json` 存在，宿主的 `.gitignore` 不跟踪它）；宿主 OpenCode 1.2.27 自身安装同理。

## 验证状态

- [x] 单测 15/15（hub 契约 / 插件 hooks / 桥接闭环）——`bun test`
- [x] 集成测试（1.19.5 本地，2026-10-29 全项通过）：
  - [x] `opencode run "帮我查一下北京的天气"` → list-skill → prepare-skill → 下一步调用 `skill-weather_get_weather` → 回复"北京当前天气晴朗，气温 21°C"（SKILL.md 引导的一句话格式生效）
  - [x] hub 日志：`[hub] agent list-skill / [hub] agent prepare-skill / [hub] exec invoke`——**invoke 只来自 exec 面，Agent 从未直调**
  - [x] 全新实例工具清单：有 list/prepare、无 `skills-hub_invoke`、无 `skill-*`（invoke 结构性隐藏 + 重启后动态 MCP 消失）
  - [x] 同实例双 session（`opencode serve` + HTTP API，脚本 `scripts/instance-sharing-check.py`）：session A 装配后 session B 可见技能工具（instance 级）；重复 prepare 同技能幂等重连；`GET /mcp` 显示 `skill-weather: connected`
  - [x] 1.19.5 的 dispose hook 触发（`[dynamic-mcp] disposed`，优雅降级设计验证）
- [ ] 1.2.27 内网测试（用户迁移后执行，清单见上方"集成测试"）
