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

  test("registers dynamic MCP via client.mcp.add and rewrites to native <skill_content> form", async () => {
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

    // 返回改写为原生技能同构形态：SKILL.md 全文 + 已挂载工具清单，留在对话历史
    const text = output.content[0].text
    expect(text).toContain('<skill_content name="weather">')
    expect(text).toContain("# Skill: weather")
    expect(text).toContain("# Weather skill") // SKILL.md 原文（validPayload 的 skillMd）
    expect(text).toContain("- `skill-weather_get_weather`: Get current weather for a city")
    expect(text).toContain("</skill_content>")
    expect(text).not.toContain("inputSchema") // mcpJson schema 仍不进对话
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
