import { FormEvent, useEffect, useState } from "react";
import { DisplayButton } from "components/display_components";
import { useApprovalSettings, useSaveApprovalSettings } from "utils/hooks/useAgentGuardQueries";

// How long a request may wait for a person before it expires. Everyone sees it; only admins change it.
export const ApprovalExpiryCard = ({ isAdmin }: { isAdmin: boolean }) => {
  const { data } = useApprovalSettings();
  const save = useSaveApprovalSettings();
  const [hours, setHours] = useState("");

  useEffect(() => {
    if (data) setHours(String(data.approvalExpiryHours));
  }, [data]);

  if (!data) return null;

  const parsed = Number(hours);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 720;
  const changed = valid && parsed !== data.approvalExpiryHours;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) save.mutate(parsed);
  };

  return (
    <section className="mb-8 rounded-lg border border-line bg-sheet p-5">
      <h2 className="text-base font-semibold">How long a request can wait</h2>
      <p className="mt-1 text-sm text-ink-soft">
        If nobody approves or rejects a request in time, it expires: nothing is done, it no longer counts towards a daily limit, and the agent is told to ask
        again.
      </p>
      {isAdmin ? (
        <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="approval-expiry-hours" className="field-label">
              Hours (1 to 720)
            </label>
            <input
              id="approval-expiry-hours"
              className="field-input w-28"
              type="number"
              inputMode="numeric"
              min={1}
              max={720}
              step={1}
              value={hours}
              onChange={(event) => setHours(event.target.value)}
            />
          </div>
          <DisplayButton type="submit" variant="primary" loading={save.isPending} disabled={!changed}>
            Save
          </DisplayButton>
          <p className="basis-full text-xs text-ink-faint">Applies to new requests. Requests already waiting keep their time.</p>
        </form>
      ) : (
        <p className="mt-2 text-sm">
          Requests wait <strong>{data.approvalExpiryHours} hours</strong>. An admin can change this.
        </p>
      )}
    </section>
  );
};
