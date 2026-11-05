import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RotateCcw, X } from "lucide-react";
import { DisplayButton, DisplayError, DisplayLoading, DisplayStatusBadge } from "components/display_components";
import { useActionDecision, useActionDetail } from "utils/hooks/useAgentGuardQueries";
import { useAuthStore } from "utils/store/authStore";
import { AgentAction } from "utils/types";
import { getErrorMessage, isNotFoundError } from "utils/services/api_services/apiClient";
import { formatDateTime } from "utils/helper_functions/format";

const ACTOR_LABEL = { agent: "Agent", user: "Person", system: "AgentGuard" };

// Undo from the details, where a link from AgentReplay lands. Asks once more, then says plainly what happened.
const DrawerUndo = ({ action }: { action: AgentAction }) => {
  const role = useAuthStore((state) => state.user?.role);
  const undo = useActionDecision("undo");
  const [confirming, setConfirming] = useState(false);

  if (action.status === "undone") {
    return (
      <p role="status" className="mt-4 rounded-md border border-undone/30 bg-undone-tint px-4 py-3 text-sm text-undone">
        <span className="font-semibold">Undone{action.undoneBy ? ` by ${action.undoneBy}` : ""}.</span> Everything this action changed is back the way it was.
      </p>
    );
  }
  if (!action.canUndo) return null;
  if (role !== "admin" && role !== "manager") {
    return <p className="mt-4 text-sm text-ink-soft">A manager or admin can undo this action.</p>;
  }
  return (
    <div className="mt-4 rounded-md border border-line px-4 py-3">
      <p className="text-sm text-ink-soft">Undo puts everything this action changed back the way it was. It is recorded in the history with your name.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {confirming ? (
          <>
            <DisplayButton variant="primary" loading={undo.isPending} onClick={() => undo.mutate({ id: action.id }, { onSettled: () => setConfirming(false) })}>
              Yes, undo it
            </DisplayButton>
            <DisplayButton variant="ghost" disabled={undo.isPending} onClick={() => setConfirming(false)}>
              Keep it
            </DisplayButton>
          </>
        ) : (
          <DisplayButton icon={<RotateCcw className="h-4 w-4" aria-hidden />} onClick={() => setConfirming(true)}>
            Undo this action
          </DisplayButton>
        )}
      </div>
    </div>
  );
};

// Everything about one action: what was asked, what we checked, and the full history.
// "onNotFound" is for links: when the id is wrong or belongs to another company, the screen decides what to show instead.
export const ActionDetailDrawer = ({
  actionId,
  onClose,
  onNotFound,
}: {
  actionId: string;
  onClose: () => void;
  onNotFound?: () => void;
}) => {
  const { data, isLoading, error } = useActionDetail(actionId);
  const notFound = isNotFoundError(error);

  useEffect(() => {
    if (notFound) onNotFound?.();
  }, [notFound, onNotFound]);

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
        {error && !(notFound && onNotFound) && <DisplayError message={getErrorMessage(error)} />}

        {data && (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <DisplayStatusBadge status={data.status} />
              <span className="text-sm text-ink-soft">{data.actionLabel}</span>
            </div>
            <h2 className="mt-3 font-serif text-xl leading-snug">{data.summary}</h2>
            {data.errorMessage && <p className="mt-3 text-sm text-refused">{data.errorMessage}</p>}
            <DrawerUndo action={data} />
            {data.guidedDemo && typeof data.params.bookingCode === "string" && (
              <Link
                to={`/walkthrough?booking=${encodeURIComponent(data.params.bookingCode)}&action=${encodeURIComponent(data.id)}`}
                className="mt-3 inline-block text-sm font-semibold text-brand underline"
              >
                Back to the guided demo →
              </Link>
            )}

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
