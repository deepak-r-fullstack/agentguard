import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Lock, RotateCcw } from "lucide-react";
import {
  DisplayButton,
  DisplayEmptyState,
  DisplayError,
  DisplayLoading,
  DisplayPageHeader,
  DisplayStatusBadge,
} from "components/display_components";
import { useActionDecision, useActions } from "utils/hooks/useAgentGuardQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatDateTime } from "utils/helper_functions/format";
import { useAuthStore } from "utils/store/authStore";
import { showToast } from "utils/store/toastStore";
import { AgentAction } from "utils/types";
import { ActionDetailDrawer } from "./ActionDetailDrawer";

const FILTERS = [
  { label: "Everything", status: undefined },
  { label: "Done", status: "done" },
  { label: "Waiting", status: "pending_approval" },
  { label: "Blocked", status: "denied" },
  { label: "Rejected", status: "rejected" },
  { label: "Expired", status: "expired" },
  { label: "Undone", status: "undone" },
  { label: "Failed", status: "failed" },
] as const;

// Undo asks once more before it runs, then gives the button back after a few seconds.
const UndoButton = ({ item }: { item: AgentAction }) => {
  const undo = useActionDecision("undo");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 6000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (!confirming) {
    return (
      <DisplayButton icon={<RotateCcw className="h-4 w-4" aria-hidden />} onClick={() => setConfirming(true)}>
        Undo
      </DisplayButton>
    );
  }
  return (
    <div className="flex gap-1">
      <DisplayButton variant="primary" loading={undo.isPending} onClick={() => undo.mutate({ id: item.id })}>
        Yes, undo it
      </DisplayButton>
      <DisplayButton variant="ghost" onClick={() => setConfirming(false)} disabled={undo.isPending}>
        Keep
      </DisplayButton>
    </div>
  );
};

export const ActivityScreen = () => {
  const user = useAuthStore((state) => state.user);
  const [status, setStatus] = useState<string | undefined>(undefined);
  // The open action lives in the address (/activity?action=<id>), so a link opens it and Back closes it.
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get("action");
  const { data, isLoading, error, refetch } = useActions(status ? { status } : {});
  const canUndo = user?.role === "admin" || user?.role === "manager";

  const openAction = (id: string) =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("action", id);
      return next;
    });

  // Closing (or a link that leads nowhere) takes ?action= out of the address.
  const closeAction = useCallback(
    () =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("action");
          return next;
        },
        { replace: true }
      ),
    [setSearchParams]
  );

  const onActionNotFound = useCallback(() => {
    showToast("We could not find that action.", "info");
    closeAction();
  }, [closeAction]);

  return (
    <>
      <DisplayPageHeader
        title="Activity"
        description="Everything agents asked to do, newest first. Open a row to see who decided what, and undo changes that went wrong."
      />

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Show">
        {FILTERS.map((filter) => {
          const active = status === filter.status;
          return (
            <button
              key={filter.label}
              type="button"
              aria-pressed={active}
              onClick={() => setStatus(filter.status)}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                active ? "border-brand bg-brand text-white" : "border-line bg-sheet text-ink-soft hover:border-ink-faint"
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {isLoading && <DisplayLoading label="Loading activity" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}
      {data && data.length === 0 && (
        <DisplayEmptyState
          title={status ? "Nothing matches this filter." : "No actions here yet."}
          description={
            status ? "Choose Everything to see all actions." : "Actions appear here as soon as an agent asks AgentGuard to do something."
          }
        />
      )}

      {data && data.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-sheet">
          {data.map((item) => (
            <li key={item.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => openAction(item.id)}
                className="min-w-0 flex-1 text-left"
                aria-label={`Open details: ${item.summary}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                  <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                  <span aria-hidden>/</span>
                  <span>{item.agentName}</span>
                </div>
                <p className="mt-1 font-serif text-lg leading-snug text-ink hover:text-brand">{item.summary}</p>
                {item.status === "denied" && item.decisionReasons[0] && (
                  <p className="mt-1 text-sm text-refused">{item.decisionReasons[0]}</p>
                )}
                {item.approvedBy && item.status !== "pending_approval" && (
                  <p className="mt-1 text-sm text-ink-soft">Approved by {item.approvedBy}</p>
                )}
                {item.undoneBy && <p className="mt-1 text-sm text-undone">Undone by {item.undoneBy}</p>}
              </button>
              <div className="flex shrink-0 items-center gap-3">
                <DisplayStatusBadge status={item.status} />
                {canUndo && item.canUndo && <UndoButton item={item} />}
                {item.status === "done" && item.irreversible && (
                  <span className="inline-flex items-center gap-1 text-xs text-ink-faint" title="This action cannot be undone">
                    <Lock className="h-3.5 w-3.5" aria-hidden /> Permanent
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {openId && <ActionDetailDrawer actionId={openId} onClose={closeAction} onNotFound={onActionNotFound} />}
    </>
  );
};
