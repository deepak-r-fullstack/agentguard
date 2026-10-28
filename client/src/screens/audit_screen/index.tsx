import { useState } from "react";
import { Download } from "lucide-react";
import { DisplayButton, DisplayEmptyState, DisplayError, DisplayLoading, DisplayPageHeader } from "components/display_components";
import { useAuditEvents } from "utils/hooks/useAgentGuardQueries";
import { auditService } from "utils/services/api_services/agentguard_service";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatDateTime } from "utils/helper_functions/format";
import { showToast } from "utils/store/toastStore";
import { useAuthStore } from "utils/store/authStore";

const ACTOR_FILTERS = [
  { label: "Everyone", value: undefined },
  { label: "Agents", value: "agent" },
  { label: "People", value: "user" },
  { label: "AgentGuard", value: "system" },
] as const;

const ACTOR_LABEL = { agent: "Agent", user: "Person", system: "AgentGuard" };

export const AuditScreen = () => {
  const user = useAuthStore((state) => state.user);
  const [actorType, setActorType] = useState<string | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const filters = actorType ? { actorType } : {};
  const { data, isLoading, error, refetch } = useAuditEvents(filters);
  const canExport = user?.role === "admin" || user?.role === "auditor";

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await auditService.exportCsv(filters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `agentguard-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(getErrorMessage(err), "error");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <DisplayPageHeader
        title="Audit log"
        description="A permanent record of every request, decision, approval and undo. Entries are never edited."
        actions={
          canExport && (
            <DisplayButton icon={<Download className="h-4 w-4" aria-hidden />} loading={downloading} onClick={download}>
              Download CSV
            </DisplayButton>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Show entries by">
        {ACTOR_FILTERS.map((filter) => {
          const active = actorType === filter.value;
          return (
            <button
              key={filter.label}
              type="button"
              aria-pressed={active}
              onClick={() => setActorType(filter.value)}
              className={`rounded-full border px-3 py-1 text-sm ${active ? "border-brand bg-brand text-white" : "border-line bg-sheet text-ink-soft hover:border-ink-faint"}`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {isLoading && <DisplayLoading label="Loading the audit log" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}
      {data && data.length === 0 && <DisplayEmptyState title="Nothing recorded yet." description="Entries appear as soon as an agent asks for something or someone changes a rule." />}

      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-sheet">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-ink-soft">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">When</th>
                <th scope="col" className="px-4 py-3 font-medium">Who</th>
                <th scope="col" className="px-4 py-3 font-medium">What happened</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((event) => (
                <tr key={event.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-ink-soft">{formatDateTime(event.createdAt)}</td>
                  <td className="px-4 py-3">
                    {event.actor.name}
                    <span className="block text-xs text-ink-faint">
                      {ACTOR_LABEL[event.actor.type]}
                      {event.onBehalfOf ? `, for ${event.onBehalfOf}` : ""}
                    </span>
                  </td>
                  <td className="px-4 py-3">{event.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};
