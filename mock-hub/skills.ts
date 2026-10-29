/**
 * Mock skills hub 的技能数据（静态表，hub 保持无状态）。
 *
 * 契约定（与插件 dynamic-mcp.ts 对齐）：
 * - skillMd 中引用的工具名 = `skill-<skillId>_<toolName>`（OpenCode 的 MCP 工具命名规则：
 *   sanitize(serverName) + "_" + sanitize(toolName)，`-` 合法字符保留）
 * - mcpJson.tools[].inputSchema 是标准 JSON Schema，插件侧原样透传（零转换）
 */

export interface SkillTool {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
}

export interface Skill {
  id: string
  title: string
  description: string
  /** 技能使用引导，prepare-skill 返回后由插件注入 system prompt */
  skillMd: string
  /** 该技能暴露的工具清单（MCP.JSON） */
  mcpJson: { tools: SkillTool[] }
  /** 本地 mock 执行器：tool 名 → 函数 */
  execute: Record<string, (args: Record<string, any>) => unknown>
}

const weather: Skill = {
  id: "weather",
  title: "Weather lookup",
  description: "Look up current weather by city",
  skillMd: [
    "# Weather skill",
    "",
    "When the user asks about the weather of a city, call the tool `skill-weather_get_weather` with `{\"city\": \"<city name>\"}`.",
    "Reply with the temperature and condition in one short sentence.",
  ].join("\n"),
  mcpJson: {
    tools: [
      {
        name: "get_weather",
        description: "Get current weather for a city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name, e.g. Beijing" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
    ],
  },
  execute: {
    get_weather: (args: { city: string }) => ({
      city: args.city,
      temperature_c: 21,
      condition: "sunny",
      source: "mock-hub",
    }),
  },
}

export const SKILLS: Skill[] = [weather]

export function findSkill(id: string): Skill | undefined {
  return SKILLS.find((s) => s.id === id)
}
