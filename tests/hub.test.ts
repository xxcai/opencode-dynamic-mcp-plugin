/**
 * 单测：mock hub 双端点协议契约（无需 OpenCode 宿主 / LLM）
 */
import { afterAll, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHub } from "../mock-hub/hub"

const hub = startHub(0) // 随机端口
const base = hub.url.toString()

afterAll(() => {
  hub.stop(true)
})

async function connect(path: string) {
  const client = new Client({ name: "hub-test", version: "0.0.1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(path, base)))
  return client
}

function parseText(result: any): any {
  expect(result.content?.[0]?.type).toBe("text")
  return JSON.parse(result.content[0].text)
}

describe("agent face (/mcp)", () => {
  test("exposes only list-skill and prepare-skill — invoke is structurally hidden", async () => {
    const client = await connect("mcp")
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["list-skill", "prepare-skill"])
    await client.close()
  })

  test("stateless: a second client can initialize against the same face", async () => {
    const a = await connect("mcp")
    const b = await connect("mcp") // stateful 1.25.2 会在这里报 "Server already initialized"
    expect(await a.ping()).toEqual({})
    expect(await b.ping()).toEqual({})
    await a.close()
    await b.close()
  })

  test("list-skill contract", async () => {
    const client = await connect("mcp")
    const result = await client.callTool({ name: "list-skill", arguments: {} })
    const payload = parseText(result)
    expect(payload.skills).toBeArrayOfSize(1)
    expect(payload.skills[0]).toMatchObject({ id: "weather", tools: ["get_weather"] })
    await client.close()
  })

  test("prepare-skill returns self-contained payload (SKILL.md + MCP.JSON)", async () => {
    const client = await connect("mcp")
    const result = await client.callTool({ name: "prepare-skill", arguments: { skill: "weather" } })
    const payload = parseText(result)
    expect(payload.ok).toBe(true)
    expect(payload.skillId).toBe("weather")
    // skillMd 引用的工具名遵循 OpenCode 命名规则 skill-<id>_<tool>
    expect(payload.skillMd).toContain("skill-weather_get_weather")
    expect(payload.mcpJson.tools[0]).toMatchObject({ name: "get_weather" })
    expect(payload.mcpJson.tools[0].inputSchema.required).toEqual(["city"])
    await client.close()
  })

  test("prepare-skill with unknown skill returns ok:false (passed through for agent self-correction)", async () => {
    const client = await connect("mcp")
    const result = await client.callTool({ name: "prepare-skill", arguments: { skill: "nope" } })
    const payload = parseText(result)
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain("unknown skill")
    await client.close()
  })
})

describe("exec face (/exec/mcp)", () => {
  test("exposes only invoke", async () => {
    const client = await connect("exec/mcp")
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["invoke"])
    await client.close()
  })

  test("invoke dispatches to the skill executor", async () => {
    const client = await connect("exec/mcp")
    const result = await client.callTool({
      name: "invoke",
      arguments: { skill: "weather", tool: "get_weather", arguments: { city: "Beijing" } },
    })
    expect(result.isError).toBeFalsy()
    const payload = parseText(result)
    expect(payload).toMatchObject({ city: "Beijing", temperature_c: 21, condition: "sunny" })
    await client.close()
  })

  test("invoke errors are carried as isError (OpenCode renders them as tool failure)", async () => {
    const client = await connect("exec/mcp")
    const result = await client.callTool({
      name: "invoke",
      arguments: { skill: "weather", tool: "no_such_tool", arguments: {} },
    })
    expect(result.isError).toBe(true)
    await client.close()
  })
})
