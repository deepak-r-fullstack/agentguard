import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import {
  DisplayButton,
  DisplayEmptyState,
  DisplayError,
  DisplayLoading,
  DisplayPageHeader,
} from "components/display_components";
import { useActionDecision, useActions } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { timeAgo } from "utils/helper_functions/format";
import { useAuthStore } from "utils/store/authStore";
import { AgentAction } from "utils/types";

// The approval slip: one request, written as a sentence, with everything a
// manager needs to decide in one look.
const ApprovalSlip = ({ item, canDecide }: { item: AgentAction; canDecide: boolean }) => {
  const approve = useActionDecision("approve");
  const reject = useActionDecision("reject");
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const busy = approve.isPending || reject.isPending;

  return (
    <article className="relative overflow-hidden rounded-lg border border-line bg-sheet" aria-labelledby={`slip-${item.id}`}>
      <span className="absolute inset-y-0 left-0 w-1 bg-waiting" aria-hidden />
      <div className="px-6 py-5 sm:px-7">
        <p className="text-sm text-ink-soft">
          <span className="font-semibold text-ink">{item.agentName}</span> asked {timeAgo(item.createdAt)}, for{" "}
          {item.onBehalfOf}
        </p>

        <h2 id={`slip-${item.id}`} className="mt-2 font-serif text-xl leading-snug text-ink sm:text-2xl">
          {item.summary}
        </h2>

        {item.reason && (
          <p className="mt-3 border-l-2 border-line pl-3 text-ink-soft">
            <span className="sr-only">Agent's reason: </span>“{item.reason}”
          </p>
        )}

        <div className="mt-4 rounded-md bg-waiting-tint/60 px-4 py-3 text-sm">
          <p className="font-semibold text-waiting">Why this needs you</p>
          <ul className="mt-1 list-disc pl-5 text-ink">
            {item.decisionReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>

        {item.irreversible && (
          <p className="mt-3 flex items-center gap-2 text-sm font-medium text-refused">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Once approved, this cannot be undone.
          </p>
        )}

        {canDecide ? (
          rejecting ? (
            <div className="mt-5 flex flex-col gap-3">
              <label htmlFor={`note-${item.id}`} className="field-label">
                Note for the team (optional)
              </label>
              <input
                id={`note-${item.id}`}
                className="field-input"
                placeholder="For example: customer already rebooked"
                value={note}
                maxLength={300}
                onChange={(event) => setNote(event.target.value)}
                autoFocus
              />
              <div className="flex flex-wrap gap-2">
                <DisplayButton variant="danger" loading={reject.isPending} onClick={() => reject.mutate({ id: item.id, note })}>
                  Reject request
                </DisplayButton>
                <DisplayButton variant="ghost" onClick={() => setRejecting(false)} disabled={busy}>
                  Go back
                </DisplayButton>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex flex-wrap gap-2">
              <DisplayButton variant="primary" size="lg" loading={approve.isPending} disabled={busy} onClick={() => approve.mutate({ id: item.id })}>
                Approve and run
              </DisplayButton>
              <DisplayButton size="lg" disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </DisplayButton>
            </div>
          )
        ) : (
          <p className="mt-5 text-sm text-ink-faint">Only managers and admins can approve or reject.</p>
        )}
      </div>
    </article>
  );
};

export const ApprovalsScreen = () => {
  const user = useAuthStore((state) => state.user);
  const { data, isLoading, error, refetch } = useActions({ status: "pending_approval" });
  const canDecide = user?.role === "admin" || user?.role === "manager";

  return (
    <>
      <DisplayPageHeader
        title="Approvals"
        description="Agents asked to do these, and your rules say a person must decide. Nothing happens until you approve."
      />
      {isLoading && <DisplayLoading label="Loading requests" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}
      {data && data.length === 0 && (
        <DisplayEmptyState
          title="Nothing is waiting for you."
          description="When an agent asks to do something risky, it will appear here. This page checks for new requests every few seconds."
          action={
            canDecide && (
              <Link to="/playground" className="text-sm font-semibold text-brand underline">
                Try an agent to see how it works
              </Link>
            )
          }
        />
      )}
      <div className="flex flex-col gap-4">
        {data?.map((item) => (
          <ApprovalSlip key={item.id} item={item} canDecide={canDecide} />
        ))}
      </div>
    </>
  );
};
