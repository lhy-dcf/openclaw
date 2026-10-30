import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import * as gatewayCallerAvailability from "../agents/tools/gateway-caller-availability.js";
import * as inProcessGateway from "../agents/tools/in-process-gateway.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
} from "../auto-reply/reply/session-event.test-support.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
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
const requesterOf = (senderId: string) => ({
  version: 1,
  channel: "telegram",
  accountId: "default",
  senderId,
});

// What the repair turn's `automations update` of its own job did, by the job's requester.
// `sent` lists the Gateway cron methods the turn's tools actually called.
const outcomes = {
  owner: { senderIsOwner: true, update: "ok", sent: ["cron.update"] },
  // A known non-owner requester never falls back to the session principal.
  "non-owner": { senderIsOwner: false, update: "gated", sent: [] },
  // Revoked while the repair waited for admission.
  "revoked-before-admission": { senderIsOwner: false, update: "gated", sent: [] },
  // Revoking publishes config, which retires the admitted turn's tool host before the write.
  "revoked-after-admission": {
    senderIsOwner: true,
    update: "agent harness host capability is no longer active",
    sent: [],
  },
} as const;

it.for(Object.keys(outcomes) as Array<keyof typeof outcomes>)(
  "runs a failure repair turn with its job requester's current authority: %s",
  async (requester, { onTestFinished }) => {
    await runEventFixture("cron-failure-repair-authority", onTestFinished, async (state) => {
      const config = await configureEventState(state, {
        channels: { telegram: {} },
        commands: { ownerAllowFrom: ["456"] },
      });
      const revoke = () =>
        setRuntimeConfigSnapshot({ ...config, commands: { ownerAllowFrom: ["789"] } });
      await replaceSessionEntry(
        { agentId: "main", sessionKey: ownerSessionKey },
        { sessionId: "repair-owner", updatedAt: Date.now() },
      );
      const job = {
        id: jobId,
        name: "Health check",
        owner: { agentId: "main", sessionKey: ownerSessionKey },
        toolsAllowProvenance: {
          channelRequester: requesterOf(requester === "non-owner" ? "789" : "456"),
        },
      } as unknown as CronStoredJob;
      const context = {
        cron: { getJob: (id: string) => (id === jobId ? job : undefined) },
        getRuntimeConfig: () => getRuntimeConfigSnapshot()!,
      } as unknown as GatewayRequestContext;
      // Only the in-process Gateway transport is recorded; the turn's own gates decide.
      const sent: string[] = [];
      const spies = [
        vi.spyOn(gatewayCallerAvailability, "hasInProcessGatewayToolCaller").mockReturnValue(true),
        vi
          .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
          .mockImplementation(async (request) => {
            sent.push(request.method);
            return { id: jobId } as never;
          }),
      ];
      onTestFinished(() => spies.forEach((spy) => spy.mockRestore()));

      let senderIsOwner: boolean | undefined;
      let update: string | undefined;
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        const { tools, close } = await openEventToolHost(params, "repair admission", {
          includeOpenClawTools: true,
        });
        senderIsOwner = params.senderIsOwner;
        if (requester === "revoked-after-admission") {
          revoke();
        }
        update = await tools
          .find((tool) => tool.name === "automations")!
          .execute("repair-update", { action: "update", jobId, job: { description: "fixed" } })
          .then(
            (result) =>
              (result.details as { gated?: boolean } | undefined)?.gated ? "gated" : "ok",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          )
          .finally(close);
        return { payloads: [{ text: "Repaired." }], meta: { durationMs: 1 } };
      });
      if (requester === "revoked-before-admission") {
        revoke();
      }

      const { runCronFailureRepair } = createGatewayCronFailureRepair(config, () => context);
      await runCronFailureRepair({
        jobId,
        repairId: `repair-${requester}`,
        timeoutMs: 60_000,
        agentId: "main",
        sessionKey: ownerSessionKey,
        message: "Automation repair request from the scheduler, not a user message.",
      });

      expect({
        senderIsOwner,
        update,
        sent: sent.filter((method) => method.startsWith("cron.")),
      }).toEqual(outcomes[requester]);
    });
  },
);
