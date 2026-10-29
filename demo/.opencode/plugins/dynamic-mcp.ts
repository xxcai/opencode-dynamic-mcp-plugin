/**
 * OpenCode 动态 MCP 桥接插件（兼容 v1.2.27 与 v1.19.5，无需版本判断）
 *
 * 职责链路（详见项目 README）：
 * 1. tool.execute.after 拦截主 MCP（skills-hub）prepare-skill 的返回
 *    → 解析 {ok, skillId, skillMd, mcpJson}（一次性自包含装配信息）
 *    → client.mcp.add 动态注册代理 MCP（instance 级、内存态、下一步对 LLM 可见）
 *    → 改写工具返回为短确认（SKILL.md 改走 system prompt 注入，mcpJson schema 不进对话）
 * 2. 代理 MCP（本进程内 Bun.serve，stateless Streamable HTTP）：listTools 原样透传 MCP.JSON
 *    的 JSON Schema；callTool 封装后经 hub 的 /exec 面绕回 invoke 元方法（Agent 不可见）
 * 3. experimental.chat.system.transform 按 session 注入 <skill_instructions>（SKILL.md）
 *
 * 兼容性（公共子集 + 优雅降级）：
 * - legacy 单函数导出格式（1.2.27 遍历命名导出；1.19.5 回退 getLegacyPlugins）→ 本文件只能有这一个导出
 * - 只用两版都有的 hooks；额外携带 dispose（1.19.5 触发清理，1.2.27 自然忽略）
 * - SDK 锁 1.25.2（见 .opencode/package.json）
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const HUB_SERVER = "skills-hub" // 与 opencode.json 中 mcp 名一致
const PREPARE_TOOL = `${HUB_SERVER}_prepare-skill` // OpenCode 工具名 = sanitize(server)_sanitize(tool)，`-` 合法保留
const EXEC_URL = process.env.SKILLS_HUB_EXEC_URL ?? "http://127.0.0.1:7777/exec/mcp"

/** MCP.JSON 中的工具定义（JSON Schema 原样透传，插件不做任何转换） */
type ProxyTool = { name: string; description?: string; inputSchema: Record<string, unknown> }

// ---- 模块级内存态（随宿主实例生灭；mcp.add 同为内存态，重启即失，语义一致） ----
const skills = new Map<string, { skillId: string; serverName: string; tools: ProxyTool[] }>()
const sessions = new Map<string, Map<string, string>>() // sessionID → (skillId → skillMd)
let execClient: MCPClient | undefined
let proxy: ReturnType<typeof Bun.serve> | undefined

/** 与 OpenCode 的 sanitize 同规则（mcp/catalog.ts / mcp/index.ts） */
const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

// ---------------------------------------------------------------------------
// exec 面 client：懒连接 + 复用；失败重置，下次调用重连
// ---------------------------------------------------------------------------

async function getExec() {
  if (execClient) return execClient
  const client = new MCPClient({ name: "opencode-dynamic-mcp-plugin", version: "0.1.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(EXEC_URL)))
  execClient = client
  return client
}

async function hubInvoke(skillId: string, tool: string, args: Record<string, unknown>) {
  try {
    const client = await getExec()
    return await client.callTool(
      { name: "invoke", arguments: { skill: skillId, tool, arguments: args } },
      CallToolResultSchema,
      { timeout: 30_000 },
    )
  } catch (e) {
    if (execClient) {
      await execClient.close().catch(() => {})
      execClient = undefined
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// 代理 MCP server：本进程内 Bun.serve，stateless（每请求 fresh Server+transport，
// SDK 1.25.2 官方 stateless 模式；该版本 stateful transport 单 session，无法承受重连）
// ---------------------------------------------------------------------------

function startProxy() {
  if (proxy) return proxy
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const m = new URL(req.url).pathname.match(/^\/mcp\/([a-zA-Z0-9_-]+)$/)
      const entry = m && skills.get(m[1])
      if (!entry) {
        return new Response(JSON.stringify({ error: `unknown skill '${m?.[1] ?? ""}'` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      const protocol = new Server({ name: entry.serverName, version: "0.1.0" }, { capabilities: { tools: {} } })
      // MCP.JSON 的 JSON Schema 原样透传（低层 Server + setRequestHandler，不经 ZodRawShape 转换）
      protocol.setRequestHandler(ListToolsRequestSchema, () => ({ tools: entry.tools }))
      protocol.setRequestHandler(CallToolRequestSchema, async (r) => {
        const { name, arguments: args = {} } = r.params
        console.log(`[dynamic-mcp] bridge ${entry.skillId}/${name} <- ${JSON.stringify(args)}`)
        try {
          // 绕回主 MCP 的 invoke（exec 面）；isError 结果原样透传，由 OpenCode 侧转为工具失败展示
          return await hubInvoke(entry.skillId, name, args as Record<string, unknown>)
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `bridge error: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          }
        }
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const res = await transport.handleRequest(req)
      await protocol.close().catch(() => {})
      return res
    },
  })
  console.log(`[dynamic-mcp] proxy listening on ${proxy.url}`)
  return proxy
}

async function stopProxy() {
  await execClient?.close().catch(() => {})
  execClient = undefined
  proxy?.stop(true)
  proxy = undefined
  skills.clear()
  sessions.clear()
  console.log("[dynamic-mcp] disposed")
}

// ---------------------------------------------------------------------------
// 插件本体（legacy 单函数导出，唯一导出）
// ---------------------------------------------------------------------------

export const DynamicSkill = async (input: PluginInput): Promise<Hooks> => {
  const client = input.client // ⚠️ hook 入参没有 client，必须在此闭包捕获（进程内 SDK client，零网络开销）
  try {
    startProxy()
  } catch (e) {
    console.error("[dynamic-mcp] proxy failed to start", e)
  }

  return {
    "tool.execute.after": async (hi, ho) => {
      if (hi.tool !== PREPARE_TOOL) return
      // 运行时 ho 是 MCP 原始 CallToolResult，与 Hooks 类型声明不符 → cast + 防御性解析
      const result = ho as unknown as { content?: Array<{ type: string; text?: string }> }
      const raw = Array.isArray(result.content) ? result.content.find((c) => c?.type === "text")?.text : undefined
      if (typeof raw !== "string") return
      let payload: {
        ok: boolean
        skillId: string
        skillMd: string
        mcpJson: { tools: ProxyTool[] }
      }
      try {
        payload = JSON.parse(raw)
      } catch {
        return // hub 报错或非 JSON：原样放行，Agent 自行纠错
      }
      if (!payload || payload.ok !== true || typeof payload.skillId !== "string" || !Array.isArray(payload.mcpJson?.tools)) return

      const skillId = sanitize(payload.skillId)
      const serverName = `skill-${skillId}`
      const toolNames = payload.mcpJson.tools.map((t) => `${serverName}_${sanitize(t.name)}`)
      try {
        if (!proxy) throw new Error("proxy server not running")
        skills.set(skillId, { skillId, serverName, tools: payload.mcpJson.tools })
        let bySkill = sessions.get(hi.sessionID)
        if (!bySkill) {
          bySkill = new Map()
          sessions.set(hi.sessionID, bySkill)
        }
        bySkill.set(skillId, String(payload.skillMd ?? ""))
        const res = await client.mcp.add({
          body: {
            name: serverName,
            config: {
              type: "remote",
              url: new URL(`mcp/${skillId}`, proxy.url).href,
              oauth: false,
              enabled: true,
            },
          },
        })
        if (res.error) throw new Error(String(res.error))
        // 两版宿主均返回扁平的 status record（1.19.5 实测、1.2.27 OpenAPI schema 一致），防御性兼容包裹形态
        const status = (res.data as any)?.[serverName]?.status ?? (res.data as any)?.status?.[serverName]?.status
        console.log(`[dynamic-mcp] registered ${serverName} status=${status ?? "?"} tools=[${toolNames.join(", ")}]`)
        // 改写工具返回：数据面（hub→插件）与 Agent 可见面分离，SKILL.md/schema 不留在对话里
        result.content = [
          {
            type: "text",
            text: `Skill "${skillId}" ready. Tools now available: ${toolNames.join(", ")}. Usage guidance was injected into your system prompt.`,
          },
        ]
      } catch (e) {
        console.error(`[dynamic-mcp] failed to register skill "${skillId}"`, e)
        result.content = [
          {
            type: "text",
            text: `[dynamic-mcp] failed to register skill "${skillId}": ${e instanceof Error ? e.message : String(e)}`,
          },
        ]
      }
    },

    "experimental.chat.system.transform": async (hi, ho) => {
      const bySkill = hi.sessionID ? sessions.get(hi.sessionID) : undefined
      if (!bySkill) return
      for (const [skillId, skillMd] of bySkill) {
        if (!skillMd) continue
        ho.system.push(`<skill_instructions skill="${skillId}">\n${skillMd}\n</skill_instructions>`)
      }
    },

    // 1.19.5 触发清理；1.2.27 无 dispose hook，此 key 被自然忽略
    dispose: async () => {
      await stopProxy()
    },
  } as Hooks
}
