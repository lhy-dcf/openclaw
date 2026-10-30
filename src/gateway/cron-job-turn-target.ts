import { isDeepStrictEqual } from "node:util";
import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { prepareCronJobRequesterOwner } from "../cron/execution-context-admission.js";
import type { CronStoredJob } from "../cron/types.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

type CronJobTurnTarget = { target: SessionEventTarget; release: () => void };

/**
 * Captures the owner conversation for a turn the scheduler starts about one job (its failure
 * repair or a notice), acting for the job's recorded requester: the same requester its
 * scheduled runs act for. An owner requester keeps owner tools while it stays an owner; a
 * non-owner requester gets none; a job with no recorded requester falls back to the
 * session principal like other unattributed system turns.
 */
export async function captureCronJobTurnTarget(params: {
  job: CronStoredJob;
  agentId: string;
  sessionKey: string;
  context?: GatewayRequestContext;
  assertCurrent?: () => void;
}): Promise<CronJobTurnTarget> {
  const { job, agentId, sessionKey } = params;
  const capture = (options: Parameters<typeof captureSessionEventTargetForHost>[2] = {}) =>
    captureSessionEventTargetForHost(agentId, sessionKey, {
      assertCurrent: params.assertCurrent,
      ...options,
    });
  if (job.operatorSource) {
    const restored = await restoreOperatorSourceTarget({ ...params, capture });
    // A refused or reset source is still this job's requester: never the session principal.
    return restored ?? { target: await capture({ requesterOwner: {} }), release: () => {} };
  }
  const cfg = params.context?.getRuntimeConfig() ?? getRuntimeConfigSnapshot();
  if (!cfg) {
    throw new Error("Automation turn requires an initialized runtime config");
  }
  const requester = await prepareCronJobRequesterOwner(cfg, job);
  params.assertCurrent?.();
  const ownerCheck = requester.owner ? requester.assertCurrent : undefined;
  const target = await capture(
    requester.requester ? { requesterOwner: ownerCheck ? { assertCurrent: ownerCheck } : {} } : {},
  );
  return { target, release: () => {} };
}

async function restoreOperatorSourceTarget(params: {
  job: CronStoredJob;
  agentId: string;
  sessionKey: string;
  context?: GatewayRequestContext;
  assertCurrent?: () => void;
  capture: (
    options: Parameters<typeof captureSessionEventTargetForHost>[2],
  ) => Promise<SessionEventTarget>;
}): Promise<CronJobTurnTarget | undefined> {
  const { job, context } = params;
  const captured = job.operatorSource;
  if (!captured || !context) {
    return undefined;
  }
  let operator: Awaited<ReturnType<typeof restoreGatewayOperatorSource>> | undefined;
  try {
    const source = decodeGatewayOperatorRecoverySource(captured.source);
    // Operator-source jobs are owned by the conversation the source names.
    if (source.agentId !== params.agentId || source.sessionKey !== params.sessionKey) {
      return undefined;
    }
    const assertCurrent = () => {
      params.assertCurrent?.();
      if (!isDeepStrictEqual(context.cron.getJob(job.id)?.operatorSource, captured)) {
        throw new Error("Automation operator source changed");
      }
    };
    operator = await restoreGatewayOperatorSource({
      snapshot: source.snapshot,
      target: {
        agentId: source.agentId,
        sessionKey: source.sessionKey,
        sessionId: source.sessionId,
      },
      context,
      assertCurrent,
    });
    const target = await params.capture({
      operatorAuthority: operator.authority,
      ownerContinuation: true,
    });
    if (target.sessionId !== source.sessionId) {
      throw new Error("Automation owner conversation was reset");
    }
    const release = operator.release;
    operator = undefined;
    return { target, release };
  } catch {
    operator?.release();
    return undefined;
  }
}
