import { expect, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent-runner/run.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { getRuntimeConfig } from "../config/config.js";
import { gatewayReplyMock } from "./test-helpers.runtime-state.js";

type RepairTurnContext = Parameters<typeof gatewayReplyMock>[0];

/**
 * Runs the next scheduler repair through real session-event admission and reply
 * dispatch; only the model call is synthetic. `respond` decides the turn's result.
 */
export function installCronRepairTurn(
  respond: (params: RunEmbeddedAgentParams) => Promise<string>,
): { context: () => RepairTurnContext | undefined } {
  let repairContext: RepairTurnContext | undefined;
  gatewayReplyMock.mockImplementationOnce((ctx, options, config) => {
    repairContext = ctx;
    return getReplyFromConfig(
      ctx,
      options,
      withFullRuntimeReplyConfig(config ?? getRuntimeConfig()),
    );
  });
  vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
    expect(params.preparedRunAdmission, "ordinary reply admission").toBeDefined();
    await params.preparedRunAdmission!.admit("gateway", params.runId);
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    const text = await respond(params);
    return {
      payloads: [{ text }],
      meta: {
        durationMs: 1,
        terminalReply: { disposition: text === "NO_REPLY" ? "silent" : "visible", text },
      },
    };
  });
  return { context: () => repairContext };
}
