import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { useAuditVerification } from "utils/hooks/useAgentGuardQueries";

// "History verified": the audit log is a chain where each entry is sealed together with the one before it,
// so a changed or removed entry shows up here. The server walks the whole chain on every check.
export const HistoryBadge = () => {
  const { data, isLoading, isError } = useAuditVerification();

  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-ink/5 px-3 py-1 text-sm text-ink-soft" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Checking history…
      </span>
    );
  }
  if (isError || !data) {
    return <span className="inline-flex items-center rounded-full bg-ink/5 px-3 py-1 text-sm text-ink-soft">History could not be checked right now</span>;
  }
  if (data.ok) {
    const older = data.legacyEvents > 0 ? ` ${data.legacyEvents} older entries from before this check existed are not covered.` : "";
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-done-tint px-3 py-1 text-sm font-semibold text-done"
        role="status"
        title={`${data.checked} entries checked, none changed or removed.${older}`}
      >
        <ShieldCheck className="h-4 w-4" aria-hidden />
        History verified
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-refused-tint px-3 py-1 text-sm font-semibold text-refused" role="alert">
      <ShieldAlert className="h-4 w-4" aria-hidden />
      History does not match: {data.brokenAt.reason}
    </span>
  );
};
