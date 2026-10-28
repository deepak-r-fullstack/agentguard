import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Play, RotateCw, Send } from "lucide-react";
import { DisplayButton, DisplayPageHeader, DisplayStatusBadge } from "components/display_components";
import { useCatalog, usePlaygroundAct, usePlaygroundChat, useResetDemo } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { useAuthStore } from "utils/store/authStore";
import { AgentAction } from "utils/types";

interface Step {
  action: string;
  params: Record<string, unknown>;
  reason: string;
}

interface Scenario {
  id: string;
  title: string;
  expect: string;
  steps: Step[];
}

// Ready-made situations that show each protection. They use the demo company's data.
const SCENARIOS: Scenario[] = [
  {
    id: "small-refund",
    title: "Cancel a small booking (₹4,500)",
    expect: "Runs on its own, because a rule allows refunds up to ₹5,000.",
    steps: [{ action: "booking.cancel", params: { bookingCode: "BK-1002" }, reason: "Customer's plans changed" }],
  },
  {
    id: "big-refund",
    title: "Cancel a big booking (₹7,500)",
    expect: "Waits in Approvals for a manager.",
    steps: [{ action: "booking.cancel", params: { bookingCode: "BK-1001" }, reason: "Customer asked in chat" }],
  },
  {
    id: "split",
    title: "Split one big refund into many small ones",
    expect: "The first few run; the one that pushes today's total past ₹20,000 is blocked.",
    steps: ["BK-1002", "BK-1003", "BK-1004", "BK-1006", "BK-1007"].map((bookingCode) => ({
      action: "booking.cancel",
      params: { bookingCode },
      reason: "Bulk cleanup",
    })),
  },
  {
    id: "big-discount",
    title: "Give a 40% discount",
    expect: "Blocked, because discounts above 30% are never allowed.",
    steps: [{ action: "booking.applyDiscount", params: { bookingCode: "BK-1005", percent: 40 }, reason: "Customer complained" }],
  },
  {
    id: "email",
    title: "Email a customer",
    expect: "Waits for approval, because an email cannot be unsent.",
    steps: [
      {
        action: "notification.sendEmail",
        params: { customerCode: "CU-104", subject: "About your houseboat trip", body: "Hello Fatima, your Kerala trip is all set." },
        reason: "Confirm trip details",
      },
    ],
  },
  {
    id: "other-company",
    title: "Reach into another company's booking",
    expect: "Not found: an agent only ever sees its own company's data.",
    steps: [{ action: "booking.cancel", params: { bookingCode: "BK-2001" }, reason: "Testing" }],
  },
  {
    id: "made-up-action",
    title: "Use an action that is not registered",
    expect: "Blocked and written to the audit log.",
    steps: [{ action: "database.deleteEverything", params: {}, reason: "Clean up" }],
  },
];

interface LogEntry {
  key: string;
  label: string;
  outcome: AgentAction | null;
  error: string | null;
}

const ResultLine = ({ entry }: { entry: LogEntry }) => (
  <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
    <div className="min-w-0">
      <p className="font-serif">{entry.outcome?.summary || entry.label}</p>
      {entry.error && <p className="text-sm text-refused">{entry.error}</p>}
      {entry.outcome?.status === "denied" && <p className="text-sm text-refused">{entry.outcome.decisionReasons.join(" ")}</p>}
      {entry.outcome?.status === "pending_approval" && (
        <p className="text-sm text-waiting">
          Waiting for a person.{" "}
          <Link to="/approvals" className="font-semibold underline">
            Open Approvals
          </Link>
        </p>
      )}
    </div>
    {entry.outcome ? (
      <DisplayStatusBadge status={entry.outcome.status} />
    ) : (
      <span className="shrink-0 rounded-full bg-refused-tint px-2.5 py-0.5 text-xs font-semibold text-refused">Refused</span>
    )}
  </li>
);

export const PlaygroundScreen = () => {
  const user = useAuthStore((state) => state.user);
  const { data: catalog } = useCatalog();
  const act = usePlaygroundAct();
  const chat = usePlaygroundChat();
  const reset = useResetDemo();

  const [onBehalfOf, setOnBehalfOf] = useState("Ravi (support team)");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [runningScenario, setRunningScenario] = useState<string | null>(null);
  const [manualAction, setManualAction] = useState("");
  const [manualParams, setManualParams] = useState("{}");
  const [manualReason, setManualReason] = useState("");
  const [manualError, setManualError] = useState("");
  const [instruction, setInstruction] = useState("");
  const [agentReply, setAgentReply] = useState("");

  const actions = catalog?.actions || [];

  useEffect(() => {
    if (!manualAction && actions.length) {
      setManualAction(actions[0].key);
      setManualParams(JSON.stringify(actions[0].exampleParams, null, 2));
    }
  }, [actions, manualAction]);

  const sendStep = async (step: Step, label: string) => {
    try {
      const response = await act.mutateAsync({ ...step, onBehalfOf });
      return { key: `${Date.now()}-${Math.random()}`, label, outcome: response.data, error: null };
    } catch (error) {
      return { key: `${Date.now()}-${Math.random()}`, label, outcome: null, error: getErrorMessage(error) };
    }
  };

  // Steps run one after another, like a real agent, and each result appears as it lands.
  const runScenario = async (scenario: Scenario) => {
    setRunningScenario(scenario.id);
    for (const step of scenario.steps) {
      const label = `${step.action} ${JSON.stringify(step.params)}`;
      const entry = await sendStep(step, label);
      setLog((current) => [entry, ...current]);
    }
    setRunningScenario(null);
  };

  const sendManual = async (event: FormEvent) => {
    event.preventDefault();
    setManualError("");
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(manualParams);
    } catch {
      setManualError("The details must be valid JSON, like the example.");
      return;
    }
    const entry = await sendStep({ action: manualAction, params, reason: manualReason }, `${manualAction} ${manualParams}`);
    setLog((current) => [entry, ...current]);
  };

  const sendInstruction = async (event: FormEvent) => {
    event.preventDefault();
    if (instruction.trim().length < 3) return;
    try {
      const response = await chat.mutateAsync({ instruction: instruction.trim(), onBehalfOf });
      setAgentReply(response.data.message);
      const entries = response.data.outcomes.map((item) => ({
        key: `${Date.now()}-${Math.random()}`,
        label: `${item.planned.action} ${JSON.stringify(item.planned.params)}`,
        outcome: item.outcome,
        error: item.error,
      }));
      setLog((current) => [...entries.reverse(), ...current]);
    } catch {
      // The hook already showed what went wrong.
    }
  };

  return (
    <>
      <DisplayPageHeader
        title="Try an agent"
        description="Send actions as a demo AI agent and watch AgentGuard decide. Everything here uses the same checks as a real agent."
        actions={
          user?.role === "admin" && (
            <DisplayButton
              variant="ghost"
              icon={<RotateCw className="h-4 w-4" aria-hidden />}
              loading={reset.isPending}
              onClick={() => reset.mutate(undefined, { onSuccess: () => setLog([]) })}
            >
              Reset demo data
            </DisplayButton>
          )
        }
      />

      <div className="mb-6 max-w-sm">
        <label htmlFor="on-behalf" className="field-label">
          The agent is working for
        </label>
        <input id="on-behalf" className="field-input" value={onBehalfOf} onChange={(event) => setOnBehalfOf(event.target.value)} />
        <p className="mt-1 text-xs text-ink-faint">A manager cannot approve work that was requested for themselves.</p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr,1fr]">
        <div className="flex flex-col gap-8">
          <section>
            <h2 className="text-lg font-semibold">Ready-made situations</h2>
            <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-sheet">
              {SCENARIOS.map((scenario) => (
                <li key={scenario.id} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div>
                    <p className="font-medium">{scenario.title}</p>
                    <p className="text-sm text-ink-soft">Expected: {scenario.expect}</p>
                  </div>
                  <DisplayButton
                    icon={<Play className="h-4 w-4" aria-hidden />}
                    loading={runningScenario === scenario.id}
                    disabled={Boolean(runningScenario) || !onBehalfOf.trim()}
                    onClick={() => runScenario(scenario)}
                    aria-label={`Run: ${scenario.title}`}
                  >
                    Run
                  </DisplayButton>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold">Ask the AI agent in your own words</h2>
            {catalog?.ai.configured ? (
              <form onSubmit={sendInstruction} className="mt-3 flex flex-col gap-2">
                <textarea
                  className="field-input min-h-[88px]"
                  placeholder="Ravi Kumar can't travel this month. Cancel his bookings."
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  maxLength={1000}
                  aria-label="Instruction for the AI agent"
                />
                <div>
                  <DisplayButton type="submit" variant="primary" icon={<Send className="h-4 w-4" aria-hidden />} loading={chat.isPending} disabled={instruction.trim().length < 3}>
                    Send to the agent
                  </DisplayButton>
                </div>
                {agentReply && <p className="font-serif text-ink-soft">Agent: {agentReply}</p>}
              </form>
            ) : (
              <p className="mt-2 text-sm text-ink-soft">
                Turned off on this server. Set LLM_PROVIDER in server/env/local.env to let an AI plan actions from plain words.
              </p>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold">Send any action</h2>
            <form onSubmit={sendManual} className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-sheet p-4">
              <div>
                <label htmlFor="manual-action" className="field-label">
                  Action
                </label>
                <select
                  id="manual-action"
                  className="field-input"
                  value={manualAction}
                  onChange={(event) => {
                    setManualAction(event.target.value);
                    const found = actions.find((item) => item.key === event.target.value);
                    if (found) setManualParams(JSON.stringify(found.exampleParams, null, 2));
                  }}
                >
                  {actions.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="manual-params" className="field-label">
                  Details (JSON)
                </label>
                <textarea id="manual-params" className="field-input min-h-[96px] font-mono text-sm" value={manualParams} onChange={(event) => setManualParams(event.target.value)} />
              </div>
              <div>
                <label htmlFor="manual-reason" className="field-label">
                  Agent's reason
                </label>
                <input id="manual-reason" className="field-input" value={manualReason} onChange={(event) => setManualReason(event.target.value)} placeholder="Customer asked in chat" />
              </div>
              {manualError && <p className="text-sm text-refused">{manualError}</p>}
              <div>
                <DisplayButton type="submit" variant="primary" loading={act.isPending && !runningScenario} disabled={!onBehalfOf.trim()}>
                  Send to AgentGuard
                </DisplayButton>
              </div>
            </form>
          </section>
        </div>

        <section aria-live="polite">
          <h2 className="text-lg font-semibold">What AgentGuard decided</h2>
          {log.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-line bg-sheet px-4 py-8 text-center text-ink-soft">
              Run a situation and each decision will appear here, newest first.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-sheet">
              {log.map((entry) => (
                <ResultLine key={entry.key} entry={entry} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
};
