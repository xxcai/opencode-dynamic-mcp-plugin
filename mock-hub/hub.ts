/**
 * Mock skills hub —— 主 MCP（skills hub）模拟器。
 *
 * 设计（详见项目 README）：
 * - 无状态：所有数据来自静态技能表（skills.ts），不维护任何连接/会话状态，可被多个 Agent 并发共享
 * - 双端点分面：
 *   - /mcp      （Agent 面，OpenCode 原生 MCP 连接）：只暴露 list-skill / prepare-skill
 *   - /exec/mcp （服务面，仅插件代理可达）          ：只暴露 invoke（结构性隐藏，Agent 永远看不到）
 * - MCP transport：stateless Streamable HTTP（每请求新建 Server+transport，SDK 1.25.2 官方
 *   stateless 模式——该版本 stateful transport 仅支持单 session，无法承受重连）
 *
 * 运行：bun run mock-hub/hub.ts（默认 127.0.0.1:7777，HUB_PORT 可覆盖）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { SKILLS, findSkill } from "./skills"

type Args = Record<string, any>

/** MCP Tool 形状（name/description/inputSchema JSON Schema） */
interface ToolDef {
  name: string
  description: string
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }
}

function textResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// 两个面的工具定义
// ---------------------------------------------------------------------------

const AGENT_TOOLS: ToolDef[] = [
  {
    name: "list-skill",
    description: "List available skill packages on the skills hub. Returns skill id/title/description and their tool names.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prepare-skill",
    description:
      "Prepare a skill package for use. MUST be called before using any skill tools. " +
      "Returns the skill's usage guide (injected into system prompt) and tool manifest (MCP.JSON, used to mount the skill tools).",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill id, from list-skill" },
      },
      required: ["skill"],
    },
  },
]

const EXEC_TOOLS: ToolDef[] = [
  {
    name: "invoke",
    description: "Meta tool: dispatch a skill tool call. Only reachable via the /exec face (never exposed to agents).",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object", description: "Tool arguments" },
        context: { type: "object", description: "Optional caller attribution (agent/session), logged only" },
      },
      required: ["skill", "tool", "arguments"],
    },
  },
]

// ---------------------------------------------------------------------------
// 调用分发（无状态）
// ---------------------------------------------------------------------------

function agentCall(name: string, args: Args) {
  if (name === "list-skill") {
    return textResult({
      skills: SKILLS.map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        tools: s.mcpJson.tools.map((t) => t.name),
      })),
    })
  }
  if (name === "prepare-skill") {
    const skill = findSkill(String(args.skill ?? ""))
    if (!skill) return textResult({ ok: false, error: `unknown skill: ${args.skill}` })
    // 一次性自包含返回：SKILL.md + MCP.JSON（hub 不留任何状态）
    return textResult({ ok: true, skillId: skill.id, skillMd: skill.skillMd, mcpJson: skill.mcpJson })
  }
  return textResult({ error: `unknown tool: ${name}` }, true)
}

function execCall(name: string, args: Args) {
  if (name !== "invoke") return textResult({ error: `unknown tool: ${name}` }, true)
  const skill = findSkill(String(args.skill ?? ""))
  if (!skill) return textResult({ error: `invoke error: unknown skill '${args.skill}'` }, true)
  const fn = skill.execute[String(args.tool ?? "")]
  if (!fn) return textResult({ error: `invoke error: unknown tool '${args.tool}' for skill '${args.skill}'` }, true)
  try {
    return textResult(fn(args.arguments ?? {}))
  } catch (e) {
    return textResult({ error: `invoke error: ${e instanceof Error ? e.message : String(e)}` }, true)
  }
}

// ---------------------------------------------------------------------------
// stateless 面处理：每请求 fresh Server + transport
// ---------------------------------------------------------------------------

function makeFaceHandler(face: "agent" | "exec", tools: ToolDef[], call: (name: string, args: Args) => any) {
  return async (req: Request): Promise<Response> => {
    const protocol = new Server({ name: `skills-hub-${face}`, version: "0.1.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
    protocol.setRequestHandler(CallToolRequestSchema, async (r) => {
      const { name, arguments: a = {} } = r.params
      console.log(`[hub] ${face} ${name} ${JSON.stringify(a)}`)
      return call(name, a)
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless：可重复 initialize、无会话亲和
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const res = await transport.handleRequest(req)
    await protocol.close().catch(() => {})
    return res
  }
}

const agentFace = makeFaceHandler("agent", AGENT_TOOLS, agentCall)
const execFace = makeFaceHandler("exec", EXEC_TOOLS, execCall)

// ---------------------------------------------------------------------------

export function startHub(port = Number(process.env.HUB_PORT ?? 7777)) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const pathname = new URL(req.url).pathname
      if (pathname === "/mcp") return agentFace(req)
      if (pathname === "/exec/mcp") return execFace(req)
      return new Response("not found", { status: 404 })
    },
  })
}

if (import.meta.main) {
  const hub = startHub()
  console.log(`[hub] skills-hub listening on ${hub.url} (agent: /mcp, exec: /exec/mcp)`)
}
