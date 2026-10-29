# Demo workspace：动态技能（dynamic MCP）使用流程

本工作区接入了一个 skills hub（远程 MCP `skills-hub`）。技能（skill）是即用即挂的能力包，使用流程固定为：

1. 用户提到某类任务（如查天气）而你还没有对应工具时，先调 `skills-hub_list-skill` 查看可用技能
2. 选择匹配的技能，调 `skills-hub_prepare-skill`（参数 `{ "skill": "<id>" }`）完成装配
3. prepare 成功后，新工具（命名形如 `skill-<id>_<tool>`，如 `skill-weather_get_weather`）会立刻出现在你的工具列表中，同时使用引导已注入 system prompt
4. 直接调用新工具完成任务；不要向用户询问是否装配，直接执行

示例：用户说"帮我查北京的天气" → list-skill → prepare-skill `{"skill":"weather"}` → 调用 `skill-weather_get_weather {"city":"Beijing"}` → 按引导回复。

注意：`skills-hub` 只暴露 `list-skill` 与 `prepare-skill` 两个工具；技能的具体执行经由装配出的 `skill-*` 工具完成。
