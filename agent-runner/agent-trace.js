/**
 * Agent Trace — per-job log of agent decisions, hints, prompts, and reasoning.
 *
 * Writes a structured JSONL file to <jobStorageDir>/agent-trace.jsonl capturing
 * every decision point the agent encounters: what context it receives, which
 * system prompt sections are active vs stripped, what pipeline hints guide it,
 * what tools are available (filtered by skip_steps), what decisions the LLM
 * makes, and what results come back.
 *
 * This is always-on (no env flag needed) and complements:
 *   - usage.json   (token counts only)
 *   - llm-data.jsonl (raw LLM I/O, only when LOG_LLM_DATA=true)
 *   - logs/*.jsonl (cross-job action summary)
 */

import fs from "fs";
import path from "path";

export class AgentTracer {
  constructor(jobStorageDir, jobMetadata) {
    this.jobStorageDir = jobStorageDir;
    this.jobMetadata = jobMetadata;
    this.stream = null;
    this.closed = false;
    this._open();
  }

  _open() {
    try {
      fs.mkdirSync(this.jobStorageDir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(this.jobStorageDir, "agent-trace.jsonl"), { flags: "a" });
      // Write a header record with job metadata
      this._write("job_start", {
        ...this.jobMetadata,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.log(`   ⚠️  [AGENT-TRACE] Could not open trace file: ${err.message}`);
      this.stream = null;
    }
  }

  _write(type, data) {
    if (this.stream && !this.closed) {
      try {
        this.stream.write(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type,
            data,
          }) + "\n",
        );
      } catch {
        /* non-fatal */
      }
    }
  }

  /**
   * Record the rendered system prompt — which sections were active and which
   * were stripped due to skip_steps.
   */
  recordSystemPrompt({ renderedPrompt, strippedSections, availableTools }) {
    this._write("system_prompt", {
      available_tools: availableTools.map((t) => t.name),
      stripped_sections: strippedSections,
      prompt_length: renderedPrompt?.length || 0,
      prompt_preview: renderedPrompt ? renderedPrompt.slice(0, 500) : null,
    });
  }

  /**
   * Record the memory context that was injected into the LLM context.
   */
  recordMemoryContext({ memorySources, totalItems, semanticResults }) {
    this._write("memory_context", {
      sources: memorySources,
      total_items: totalItems,
      semantic_results: semanticResults,
    });
  }

  /**
   * Record a pipeline hint resolution — how the agent decided what the LLM
   * should do next.
   */
  recordHintResolution({ fromTool, hintText, resolvedTo, wasSkipped, skipChain }) {
    this._write("hint_resolution", {
      from_tool: fromTool,
      hint_preview: hintText ? hintText.slice(0, 200) : null,
      resolved_to: resolvedTo,
      was_skipped: wasSkipped,
      skip_chain: skipChain,
    });
  }

  /**
   * Record an LLM decision — what tool it chose and with what arguments.
   */
  recordLlmDecision({ step, decision, error }) {
    this._write("llm_decision", {
      step,
      tool: decision?.name || null,
      arguments: decision?.arguments || null,
      usage: decision?.usage || null,
      error: error || null,
    });
  }

  /**
   * Record the available tools at a given step (after any locking/filtering).
   */
  recordAvailableTools({ step, tools }) {
    this._write("available_tools", {
      step,
      tools: tools.map((t) => t.name),
      count: tools.length,
    });
  }

  /**
   * Record a tool execution result.
   */
  recordToolResult({ step, toolName, success, resultPreview, error }) {
    this._write("tool_result", {
      step,
      tool: toolName,
      success,
      result_preview: resultPreview
        ? typeof resultPreview === "string"
          ? resultPreview.slice(0, 300)
          : JSON.stringify(resultPreview).slice(0, 300)
        : null,
      error: error || null,
    });
  }

  /**
   * Record a pipeline control decision (skip, lock, terminal detection, etc.).
   */
  recordControlDecision({ step, type, detail }) {
    this._write("control_decision", {
      step,
      control_type: type,
      detail,
    });
  }

  /**
   * Record pipeline completion or failure.
   */
  recordPipelineEnd({ status, error, totalSteps, tokensUsed }) {
    this._write("pipeline_end", {
      status,
      error: error || null,
      total_steps: totalSteps,
      total_tokens: tokensUsed,
    });
  }

  /**
   * Record the skip_steps configuration that was applied.
   */
  recordSkipConfig({ skippedTools, skipSource }) {
    this._write("skip_config", {
      skipped_tools: [...skippedTools],
      source: skipSource,
    });
  }

  close() {
    if (this.stream && !this.closed) {
      try {
        this.stream.end();
      } catch {
        /* ignore */
      }
      this.closed = true;
      this.stream = null;
    }
  }
}
