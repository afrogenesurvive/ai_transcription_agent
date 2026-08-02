/**
 * JSON Schema validating agent-config/tools.json and agent-config/pipeline.json.
 *
 * IMPORTANT: This is a TS copy of the canonical schema committed at the repo
 * root (agent-config/schema.json) so the renderer can validate before saving
 * without a fragile cross-root import. Keep the two files in sync when editing
 * either one. The schema is inlined into the Vite bundle at build time.
 */
export const agentConfigSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  description: "JSON Schema validating agent-config/tools.json (array of tool defs) and agent-config/pipeline.json (pipeline constants/steps/hints) for UI editing",
  oneOf: [{ $ref: "#/definitions/tools_file" }, { $ref: "#/definitions/pipeline_file" }],
  definitions: {
    tools_file: {
      type: "array",
      description: "tools.json — array of tool definitions in OpenAI function-calling format",
      items: { $ref: "#/definitions/tool" },
    },
    pipeline_file: {
      type: "object",
      description: "pipeline.json — pipeline constants, ordered steps, hints, and event templates",
      properties: {
        max_pipeline_steps: { type: "integer", minimum: 1 },
        max_retries: { type: "integer", minimum: 0 },
        retry_base_delay_ms: { type: "integer", minimum: 0 },
        ollama_max_retries: { type: "integer", minimum: 0 },
        ollama_retry_base_delay_ms: { type: "integer", minimum: 0 },
        llm_context_window: { type: "integer", minimum: 0 },
        terminal_tools: { type: "array", items: { type: "string", pattern: "^[a-z_]+$" } },
        pipeline_steps: { $ref: "#/definitions/pipeline_steps" },
        pipeline_hints: { $ref: "#/definitions/pipeline_hints" },
        event_templates: { $ref: "#/definitions/event_templates" },
      },
      additionalProperties: true,
    },
    tool: {
      type: "object",
      required: ["name", "description", "terminal", "handler", "inputSchema"],
      properties: {
        name: { type: "string", pattern: "^[a-z_]+$", description: "Unique tool identifier, lowercase with underscores" },
        description: { type: "string", maxLength: 1000, description: "Short description shown to the LLM" },
        terminal: { type: "boolean", description: "If true, calling this tool ends the pipeline" },
        handler: {
          type: "string",
          enum: ["bridge", "direct"],
          description: "Execution method: 'bridge' proxies to Python backend, 'direct' calls external APIs",
        },
        inputSchema: { type: "object", description: "JSON Schema defining the tool's arguments (OpenAI function-calling format)" },
      },
    },
    pipeline_steps: {
      type: "array",
      description: "Ordered pipeline steps for the draggable checklist UI. Defines step ordering, enabled/disabled state, labels, and hint templates.",
      items: {
        type: "object",
        required: ["id", "toolName", "label", "description", "enabled", "isTerminal"],
        properties: {
          id: { type: "string", pattern: "^step-\\d+$", description: "Unique step identifier" },
          toolName: { type: "string", pattern: "^[a-z_]+$", description: "Tool name this step invokes" },
          label: { type: "string", maxLength: 100, description: "Human-readable step label" },
          description: { type: "string", maxLength: 200, description: "Short description of what this step does" },
          systemPromptTemplate: {
            type: "string",
            maxLength: 500,
            description: "Custom system prompt text for this step. Use {tool} as placeholder.",
          },
          hintTemplate: { type: "string", maxLength: 500, description: "Pipeline hint text shown to the LLM after this step executes" },
          enabled: { type: "boolean", description: "Whether this step is active in the pipeline" },
          isTerminal: { type: "boolean", description: "If true, calling this tool ends the pipeline" },
        },
      },
    },
    pipeline_hints: {
      type: "object",
      patternProperties: {
        "^[a-z_]+$": { type: "string", maxLength: 500 },
      },
      additionalProperties: false,
    },
    event_templates: {
      type: "object",
      properties: {
        ready_for_processing: { type: "string", maxLength: 2000 },
        failed: { type: "string", maxLength: 2000 },
      },
      required: ["ready_for_processing", "failed"],
    },
  },
};
