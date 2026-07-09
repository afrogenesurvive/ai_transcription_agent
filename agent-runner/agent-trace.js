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
      prompt_preview: renderedPrompt, // full prompt text — removed 500-char truncation
    });
  }

  /**
   * Record the breakdown of how the LLM context (instructions) was assembled.
   * Captures each section that composes the final context sent to the model.
   */
  recordContextComposition({ eventType, templateName, variableSubstitutions, contextSections }) {
    this._write("context_composition", {
      event_type: eventType,
      template_name: templateName,
      variable_substitutions: variableSubstitutions,
      context_sections: contextSections,
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
      hint_preview: hintText, // full hint text — removed 200-char truncation
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
          ? resultPreview.slice(0, 10000)
          : JSON.stringify(resultPreview).slice(0, 10000)
        : null,
      error: error || null,
    });
  }

  /**
   * Record a full snapshot of the LLM context at a given pipeline step.
   * This is the "everything" mode — it captures the entire context string
   * as sent to the LLM, enabling full post-hoc analysis.
   * Only written when AGENT_TRACE_FULL_CONTEXT=true env var is set, since
   * it can produce very large trace files.
   */
  recordContextSnapshot({ step, context }) {
    if (process.env.AGENT_TRACE_FULL_CONTEXT !== "true") return;
    this._write("context_snapshot", {
      step,
      context_length: context?.length || 0,
      context, // full context text
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
  recordPipelineEnd({ status, error, totalSteps, tokensUsed, finalContextLength, contextGrowth, llmDataLogged }) {
    this._write("pipeline_end", {
      status,
      error: error || null,
      total_steps: totalSteps,
      total_tokens: tokensUsed,
      final_context_length: finalContextLength,
      context_growth: contextGrowth,
      llm_data_logged: llmDataLogged || false,
      full_context_available: process.env.AGENT_TRACE_FULL_CONTEXT === "true",
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

  /**
   * Record a context update — when the LLM context grows due to step results
   * or pipeline hints being appended.
   */
  recordContextUpdate({ step, toolName, hintAppended, contextLengthDelta, contextLengthTotal }) {
    this._write("context_update", {
      step,
      tool: toolName,
      hint_appended: hintAppended,
      context_length_delta: contextLengthDelta,
      context_length_total: contextLengthTotal,
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
