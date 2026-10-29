/**
 * 单测：桥接闭环（真 MCP client → 插件代理 → mock hub /exec invoke → 结果透传）
 *
 * mock hub 固定起在 7777 端口，与插件默认 EXEC_URL（http://127.0.0.1:7777/exec/mcp）对齐。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startHub } from "../mock-hub/hub"
import { DynamicSkill } from "../demo/.opencode/plugins/dynamic-mcp"

const hub = startHub(7777)
const PREPARE = "skills-hub_prepare-skill"

afterAll(() => {
  hub.stop(true)
})

function makeFakeInput() {
  const added: any[] = []
  const input = {
    client: {
      mcp: {
        add: async (opts: any) => {
          added.push(opts)
          return { data: { status: { [opts.body.name]: { status: "connected" } } } }
        },
      },
    },
  } as any
  return { input, added }
}

async function connect(url: string) {
  const client = new MCPClient({ name: "proxy-test", version: "0.0.1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

describe("bridge loop: prepare → dynamic MCP → invoke", () => {
  const fake = makeFakeInput()

  test("full round trip", async () => {
    const hooks = (await DynamicSkill(fake.input)) as any

    // 1. 从 hub 拿真实的 prepare-skill 返回（与生产路径一致：内容就是 hub 的 JSON 文本）
    const hubAgent = await connect(new URL("mcp", hub.url).toString())
    const prepareRes = await hubAgent.callTool({ name: "prepare-skill", arguments: { skill: "weather" } })
    const output = { content: prepareRes.content }
    await hubAgent.close()

    // 2. 喂给插件的 after-hook（模拟 OpenCode 的 tool.execute.after 触发）
    await hooks["tool.execute.after"]({ tool: PREPARE, sessionID: "ses_bridge", callID: "c" }, output as any)
    expect(fake.added).toHaveLength(1)
    const proxyUrl = fake.added[0].body.config.url
    expect(proxyUrl).toMatch(/\/mcp\/weather$/)

    // 3. 以"OpenCode MCP client"的身份连上动态注册的代理 server
    const proxyClient = await connect(proxyUrl)
    const { tools } = await proxyClient.listTools()
    expect(tools.map((t) => t.name)).toEqual(["get_weather"])
    // MCP.JSON 的 JSON Schema 原样透传
    expect(tools[0].inputSchema).toMatchObject({ type: "object", required: ["city"] })

    // 4. 调用代理工具 → 插件经 /exec 面绕回 hub.invoke → 结果透传（hub 日志佐证）
    const result = await proxyClient.callTool({ name: "get_weather", arguments: { city: "Beijing" } })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0].text)
    expect(payload).toMatchObject({ city: "Beijing", temperature_c: 21, condition: "sunny" })

    // 5. stateless：可重复 initialize（幂等重连场景）
    const again = await connect(proxyUrl)
    expect((await again.listTools()).tools).toHaveLength(1)
    await again.close()
    await proxyClient.close()
  })

  test("proxy returns 404 for unknown skill routes", async () => {
    const proxyUrl = fake.added[0].body.config.url
    const base = new URL("/", proxyUrl)
    const res = await fetch(new URL("mcp/no-such-skill", base))
    expect(res.status).toBe(404)
  })
})
