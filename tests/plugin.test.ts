/**
 * 单测：插件 hooks 行为（fake PluginInput，无需 OpenCode 宿主 / LLM）
 * 注意：插件是模块级单例（skills/sessions/proxy 为模块状态），各用例用不同 sessionID 隔离。
 */
import { describe, expect, test } from "bun:test"
import { DynamicSkill } from "../demo/.opencode/plugins/dynamic-mcp"

const PREPARE = "skills-hub_prepare-skill"

/** 与 mock hub prepare-skill 返回同构的 payload */
const validPayload = {
  ok: true,
  skillId: "weather",
  skillMd: "# Weather skill\ncall `skill-weather_get_weather` with city",
  mcpJson: {
    tools: [
      {
        name: "get_weather",
        description: "Get current weather for a city",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ],
  },
}

function payloadResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

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
    project: {},
    directory: "/tmp/demo",
    worktree: "/tmp/demo",
    serverUrl: new URL("http://127.0.0.1:1"),
    experimental_workspace: { register: () => {} },
    $: {} as any,
  } as any
  return { input, added }
}

async function setup() {
  const fake = makeFakeInput()
  const hooks = (await DynamicSkill(fake.input)) as any
  return { fake, hooks }
}

describe("tool.execute.after @ prepare-skill", () => {
  test("ignores other tools entirely", async () => {
    const { hooks } = await setup()
    const output = payloadResult({ some: "data" })
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_a", callID: "c" }, output as any)
    expect(JSON.parse(output.content[0].text)).toEqual({ some: "data" })
  })

  test("passes through non-JSON / ok:false payloads untouched", async () => {
    const { hooks } = await setup()
    const bad = { content: [{ type: "text", text: "not json at all" }] }
    await hooks["tool.execute.after"]({ tool: PREPARE, sessionID: "ses_b", callID: "c" }, bad as any)
    expect(bad.content[0].text).toBe("not json at all")

    const rejected = payloadResult({ ok: false, error: "unknown skill: nope" })
    await hooks["tool.execute.after"]({ tool: PREPARE, sessionID: "ses_b", callID: "c" }, rejected as any)
    expect(JSON.parse(rejected.content[0].text).ok).toBe(false)
  })

  test("registers dynamic MCP via client.mcp.add and rewrites the tool result", async () => {
    const { fake, hooks } = await setup()
    const output = payloadResult(validPayload)
    await hooks["tool.execute.after"]({ tool: PREPARE, sessionID: "ses_c", callID: "c" }, output as any)

    // mcp.add 参数
    expect(fake.added).toHaveLength(1)
    const add = fake.added[0].body
    expect(add.name).toBe("skill-weather")
    expect(add.config.type).toBe("remote")
    expect(add.config.oauth).toBe(false)
    expect(add.config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/weather$/)

    // 返回改写为短确认：含工具名、不含 SKILL.md 全文与 mcpJson schema
    const text = output.content[0].text
    expect(text).toContain("skill-weather_get_weather")
    expect(text).not.toContain("# Weather skill")
    expect(text).not.toContain("inputSchema")
  })

  test("rewrites result with failure message when mcp.add throws", async () => {
    const failing = makeFakeInput()
    failing.input.client.mcp.add = async () => {
      throw new Error("boom")
    }
    const hooks = (await DynamicSkill(failing.input)) as any
    const output = payloadResult(validPayload)
    await hooks["tool.execute.after"]({ tool: PREPARE, sessionID: "ses_d", callID: "c" }, output as any)
    expect(output.content[0].text).toContain("failed to register")
    expect(output.content[0].text).toContain("boom")
  })
})

describe("experimental.chat.system.transform", () => {
  test("injects <skill_instructions> only for sessions that prepared", async () => {
    const { hooks } = await setup()
    // ses_c 在上一组用例中已 prepare（模块单例状态）
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_c" } as any, output as any)
    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain('<skill_instructions skill="weather">')
    expect(output.system[0]).toContain("skill-weather_get_weather")

    const other = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_unknown" } as any, other as any)
    expect(other.system).toHaveLength(0)
  })
})
