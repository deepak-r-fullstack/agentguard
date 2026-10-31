import { AgentReplay, Run } from "@sritarak/agentreplay";
import { env } from "../../config/env";
import { ActionRecordDoc } from "../../models/actionRecord.model";

// ---------------------------------------------------------------------------
// Optional recording of playground runs in AgentReplay (the sister project that
// replays what an AI did). Off by default: with no AGENTREPLAY_API_KEY nothing
// is created, recorded or sent, and the package is never started.
//
// The rules that keep the playground safe:
//  - recording only ever ADDS a link to AgentReplay; it has no way to change or undo an action
//  - nothing here waits for the network: the SDK queues steps and sends them in the background
//  - a recording problem is swallowed; the playground answers exactly as it would without it
// ---------------------------------------------------------------------------

export interface PlaygroundRecording {
  /** Runs the AI planning call and records it as an "llm" step. Your result and errors come back unchanged. */
  recordPlanning<T>(instruction: string, work: () => Promise<T>): Promise<T>;
  /** Records one guarded action as a "tool" step that links back to its Activity page. */
  recordAction(action: string, params: unknown, outcome: { record: ActionRecordDoc } | { errorMessage: string }): void;
  /** Ends the run and sends what is waiting, without making the caller wait. */
  finish(): void;
}

export function isAgentReplayConfigured(): boolean {
  return Boolean(env.AGENTREPLAY_API_KEY);
}

// The page that opens one action's details (the Activity screen reads ?action=).
export function activityLink(actionId: string): string {
  return `${env.CLIENT_ORIGIN.replace(/\/+$/, "")}/activity?action=${encodeURIComponent(actionId)}`;
}

// What the step shows as its output: the result once it is done, otherwise where the action stands.
function describeOutcome(record: ActionRecordDoc) {
  if (record.status === "done") return { status: record.status, result: record.result };
  return { status: record.status, reasons: record.decisionReasons };
}

const NOT_RECORDING: PlaygroundRecording = {
  recordPlanning: (_instruction, work) => work(),
  recordAction: () => undefined,
  finish: () => undefined,
};

/** One recording per playground request. With no key it does nothing at all. */
export function startPlaygroundRecording(input: { name: string; onBehalfOf: string }): PlaygroundRecording {
  if (!isAgentReplayConfigured()) return NOT_RECORDING;

  let client: AgentReplay;
  let run: Run;
  try {
    // A client of its own per request (not the SDK's shared one), so nothing outside this request is touched.
    client = new AgentReplay({ apiKey: env.AGENTREPLAY_API_KEY, baseUrl: env.AGENTREPLAY_URL || undefined });
    run = client.startRun({ name: input.name, userRef: input.onBehalfOf });
  } catch {
    return NOT_RECORDING;
  }

  return {
    recordPlanning: (instruction, work) =>
      run.trace("llm", "plan_actions", work, { input: instruction, model: env.LLM_MODEL || env.LLM_PROVIDER }),

    recordAction: (action, params, outcome) => {
      try {
        if ("errorMessage" in outcome) {
          run.step({ type: "tool", name: action, input: params, error: outcome.errorMessage });
          return;
        }
        const actionId = String(outcome.record._id);
        run.step({
          type: "tool",
          name: action,
          input: params,
          output: describeOutcome(outcome.record),
          externalRef: { system: "agentguard", id: actionId, url: activityLink(actionId) },
        });
      } catch {
        // Never let recording reach the playground.
      }
    },

    finish: () => {
      try {
        run.end();
        void client.flush(); // never rejects, and is not waited for
      } catch {
        // Never let recording reach the playground.
      }
    },
  };
}
