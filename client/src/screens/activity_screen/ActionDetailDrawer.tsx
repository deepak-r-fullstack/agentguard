import { useEffect } from "react";
import { X } from "lucide-react";
import { DisplayError, DisplayLoading, DisplayStatusBadge } from "components/display_components";
import { useActionDetail } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatDateTime } from "utils/helper_functions/format";

const ACTOR_LABEL = { agent: "Agent", user: "Person", system: "AgentGuard" };

// Everything about one action: what was asked, what we checked, and the full history.
export const ActionDetailDrawer = ({ actionId, onClose }: { actionId: string; onClose: () => void }) => {
  const { data, isLoading, error } = useActionDetail(actionId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Action details">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden />
      <div className="drawer-enter absolute right-0 top-0 h-full w-full max-w-lg overflow-y-auto bg-sheet px-6 py-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-ink-soft">Action details</p>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-soft hover:bg-ink/5" aria-label="Close details">
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading && <DisplayLoading />}
        {error && <DisplayError message={getErrorMessage(error)} />}

        {data && (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <DisplayStatusBadge status={data.status} />
              <span className="text-sm text-ink-soft">{data.actionLabel}</span>
            </div>
            <h2 className="mt-3 font-serif text-xl leading-snug">{data.summary}</h2>
            {data.errorMessage && <p className="mt-3 text-sm text-refused">{data.errorMessage}</p>}

            <dl className="mt-6 grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-faint">Agent</dt>
              <dd>{data.agentName}</dd>
              <dt className="text-ink-faint">Working for</dt>
              <dd>{data.onBehalfOf}</dd>
              {data.reason && (
                <>
                  <dt className="text-ink-faint">Agent's reason</dt>
                  <dd>“{data.reason}”</dd>
                </>
              )}
              <dt className="text-ink-faint">Rule check</dt>
              <dd>
                <ul className="list-disc pl-4">
                  {data.decisionReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </dd>
              <dt className="text-ink-faint">Can be undone</dt>
              <dd>{data.irreversible ? "No, this is permanent" : "Yes"}</dd>
            </dl>

            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-ink-soft hover:text-ink">What the agent sent and what we checked</summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-paper p-3 text-xs leading-relaxed">
                {JSON.stringify({ sentByAgent: data.params, checkedByAgentGuard: data.facts }, null, 2)}
              </pre>
            </details>

            <h3 className="mt-8 text-base font-semibold">History</h3>
            <ol className="mt-3 border-l border-line pl-5">
              {data.timeline?.map((event) => (
                <li key={event.id} className="relative pb-5 last:pb-0">
                  <span className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-brand" aria-hidden />
                  <p className="text-sm">{event.summary}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {ACTOR_LABEL[event.actor.type]}: {event.actor.name}, {formatDateTime(event.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
};
