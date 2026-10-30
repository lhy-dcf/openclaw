import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
} from "../auto-reply/reply/session-event.test-support.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { CronStoredJob } from "../cron/types.js";
import { createGatewayCronFailureRepair } from "./server-cron-notifications.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

// mock-isolation: Synthetic model only; repair dispatch, admission and the tool gate are real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
// Match Gateway startup: activate the real reply runtimes before timing turn authority.
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

const ownerSessionKey = "agent:main:telegram:direct:456";
const jobId = "repair-authority-job";
const ownerRequester = { version: 1, channel: "telegram", accountId: "default", senderId: "456" };

// What the repair turn could do with the job it repairs, by the job's recorded requester.
// "gateway" means the call passed the turn's owner gate and reached the Gateway transport.
const outcomes = {
  // An owner requester: the turn reads and updates the job.
  owner: { senderIsOwner: true, get: "gateway", update: "gateway" },
  // A known non-owner requester never falls back to the session principal.
  "non-owner": { senderIsOwner: false, update: "gated" },
} as const;

it.for(Object.keys(outcomes) as Array<keyof typeof outcomes>)(
  "runs a failure repair turn with its job requester's current authority: %s",
  async (requester, { onTestFinished }) => {
    await runEventFixture("cron-failure-repair-authority", onTestFinished, async (state) => {
      const config = await configureEventState(state, {
        channels: { telegram: {} },
        commands: { ownerAllowFrom: ["456"] },
      });
      await replaceSessionEntry(
        { agentId: "main", sessionKey: ownerSessionKey },
        { sessionId: "repair-owner", updatedAt: Date.now() },
      );
      const job = {
        id: jobId,
        name: "ClawSweeper health",
        owner: { agentId: "main", sessionKey: ownerSessionKey },
        toolsAllowProvenance: {
          channelRequester:
            requester === "non-owner" ? { ...ownerRequester, senderId: "789" } : ownerRequester,
        },
      } as unknown as CronStoredJob;
      const context = {
        cron: { getJob: (id: string) => (id === jobId ? job : undefined) },
        getRuntimeConfig: () => getRuntimeConfigSnapshot()!,
      } as unknown as GatewayRequestContext;
      let senderIsOwner: boolean | undefined;
      const results: Record<string, string> = {};
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        const { tools, close } = await openEventToolHost(params, "repair admission", {
          includeOpenClawTools: true,
        });
        senderIsOwner = params.senderIsOwner;
        const automations = tools.find((tool) => tool.name === "automations")!;
        try {
          for (const [action, args] of [
            ["get", { action: "get", jobId }],
            ["update", { action: "update", jobId, job: { description: "repaired" } }],
          ] as const) {
            // A gated call settles without reaching the Gateway; a passed one reaches the
            // transport, which this fixture does not run.
            const details = await automations.execute(`repair-${action}`, args).then(
              (result) => result.details as { gated?: boolean } | undefined,
              () => undefined,
            );
            results[action] = details?.gated ? "gated" : "gateway";
          }
          if (requester === "non-owner") {
            delete results.get;
          }
        } finally {
          close();
        }
        return { payloads: [{ text: "Repaired." }], meta: { durationMs: 1 } };
      });

      const { runCronFailureRepair } = createGatewayCronFailureRepair(config, () => context);
      await runCronFailureRepair({
        jobId,
        repairId: `repair-${requester}`,
        timeoutMs: 60_000,
        agentId: "main",
        sessionKey: ownerSessionKey,
        message: "Automation repair request from the scheduler, not a user message.",
      });

      expect({ senderIsOwner, ...results }).toEqual(outcomes[requester]);
    });
  },
);
