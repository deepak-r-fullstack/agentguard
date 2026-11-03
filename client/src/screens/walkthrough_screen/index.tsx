import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { DisplayButton, DisplayError, DisplayPageHeader, DisplayStatusBadge } from "components/display_components";
import { useActionDecision, useActionDetail, useCompanyData, usePlaygroundAct } from "utils/hooks/useAgentGuardQueries";
import { demoService } from "utils/services/api_services/agentguard_service";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { useAuthStore } from "utils/store/authStore";

// This screen uses the ordinary action/approval/undo endpoints. Each visitor gets
// a fresh booking instead of resetting company data used by other visitors.
export const WalkthroughScreen = () => {
  const user = useAuthStore((state) => state.user);
  const [bookingCode, setBookingCode] = useState("");
  const [recordingUrl, setRecordingUrl] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const act = usePlaygroundAct();
  const approve = useActionDecision("approve");
  const undo = useActionDecision("undo");
  const { data: action } = useActionDetail(actionId);
  const { data: company, refetch: refreshCompany } = useCompanyData();
  const { data: recording } = useQuery({ queryKey: ["demo-recording"], queryFn: () => demoService.recording().then((response) => response.data) });
  const booking = company?.bookings.find((item) => item.code === bookingCode);
  const busy = starting || act.isPending || approve.isPending || undo.isPending;

  const start = async () => {
    setError("");
    setStarting(true);
    try {
      const response = await demoService.startWalkthrough();
      setBookingCode(response.data.bookingCode);
      setActionId(null);
      setRecordingUrl("");
      await refreshCompany();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const request = async () => {
    setError("");
    try {
      const response = await act.mutateAsync({
        action: "booking.cancel",
        params: { bookingCode },
        onBehalfOf: "Demo support visitor",
        reason: "Guided demo: customer asked to cancel"
      });
      setActionId(response.data.id);
      setRecordingUrl(response.data.recording?.url || "");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  return (
    <>
      <DisplayPageHeader
        title="Approve it. Inspect it. Undo it."
        description="A real workflow using practice bookings. No emails or payments leave this demo."
      />
      <p className="mb-6 max-w-2xl text-sm text-ink-soft">
        Each attempt creates a separate booking. Company rules and daily caps are shared with other demo visitors, so a changed rule or a busy demo may refuse a
        request. Starting again never resets anyone else’s data.
      </p>
      {error && <DisplayError message={error} />}
      <ol className="grid gap-4 lg:grid-cols-3">
        <li className="rounded-lg border border-line bg-sheet p-5">
          <h2 className="font-semibold">1. Prepare a booking</h2>
          <p className="mt-2 text-sm text-ink-soft">Create a confirmed practice booking for ₹7,500. It is above the demo’s automatic-refund threshold.</p>
          <div className="mt-4">
            <DisplayButton variant="primary" loading={starting} disabled={busy || Boolean(bookingCode && action?.status !== "undone")} onClick={start}>
              {bookingCode ? "Start another walkthrough" : "Prepare my booking"}
            </DisplayButton>
          </div>
          {bookingCode && (
            <p className="mt-3 break-all text-sm" data-testid="booking-code">
              {bookingCode}
            </p>
          )}
        </li>
        <li className="rounded-lg border border-line bg-sheet p-5">
          <h2 className="font-semibold">2. Request, then approve</h2>
          <p className="mt-2 text-sm text-ink-soft">Request cancellation as the support agent. Inspect the pending request before approving as {user?.name}.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <DisplayButton disabled={busy || !bookingCode || Boolean(actionId)} loading={act.isPending} onClick={request}>
              Request cancellation
            </DisplayButton>
            {action?.status === "pending_approval" && (
              <DisplayButton variant="primary" loading={approve.isPending} disabled={busy} onClick={() => approve.mutate({ id: action.id })}>
                Approve cancellation
              </DisplayButton>
            )}
          </div>
          {action && (
            <div className="mt-4">
              <DisplayStatusBadge status={action.status} />
              <p className="mt-2 text-sm text-ink-soft">{action.decisionReasons.join(" ")}</p>
            </div>
          )}
          {action?.errorMessage && <p className="mt-3 text-sm text-refused">{action.errorMessage}</p>}
        </li>
        <li className="rounded-lg border border-line bg-sheet p-5">
          <h2 className="font-semibold">3. Check the change, then undo</h2>
          <dl className="mt-3 space-y-2 text-sm" aria-live="polite">
            <div>
              <dt className="text-ink-faint">Booking status</dt>
              <dd data-testid="booking-status">{booking?.status || "Prepare a booking first"}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Demo refund</dt>
              <dd data-testid="booking-refund">{booking ? `₹${booking.refundAmount.toLocaleString("en-IN")}` : "—"}</dd>
            </div>
          </dl>
          {action?.canUndo && (
            <div className="mt-4">
              <DisplayButton variant="primary" loading={undo.isPending} disabled={busy} onClick={() => undo.mutate({ id: action.id })}>
                Undo cancellation
              </DisplayButton>
            </div>
          )}
          {action?.status === "undone" && booking?.status === "confirmed" && booking.refundAmount === 0 && (
            <p role="status" className="mt-4 text-sm font-semibold text-brand">
              Restored. The booking is confirmed and its refund is zero.
            </p>
          )}
          {actionId && (
            <Link to={`/activity?action=${encodeURIComponent(actionId)}`} className="mt-4 inline-block text-sm font-semibold text-brand underline">
              Inspect full action history →
            </Link>
          )}
        </li>
      </ol>
      {action && ["denied", "expired", "rejected", "failed"].includes(action.status) && (
        <div className="mt-5">
          <p className="mb-3 text-sm text-ink-soft">This request did not complete. Inspect its history for the reason, then try a new booking.</p>
          <DisplayButton disabled={busy} onClick={start}>
            Try a new booking
          </DisplayButton>
        </div>
      )}
      <section className="mt-8 max-w-3xl rounded-lg border border-line bg-sheet p-5">
        <h2 className="font-semibold">See how a developer investigates a bad run</h2>
        <p className="mt-2 text-sm text-ink-soft">
          {recording?.configured
            ? "Optional AgentReplay recording is configured on this server. New requests are recorded in its configured app; the app owner can inspect them. Recording failures never block this workflow."
            : "Recording to AgentReplay is not connected on this server. You can still explore its separate wrong-refund sample, fork a prompt and save a regression test."}
        </p>
        {recordingUrl && (
          <p className="mt-3 text-sm text-ink-soft">
            <a href={recordingUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand underline">
              Open this request’s queued recording ↗
            </a>{" "}
            Recording is sent in the background and may be delayed or unavailable. It captures the request before approval; current outcomes and undo stay in
            AgentGuard. Sign in to the configured AgentReplay workspace to view it.
          </p>
        )}
        <a
          href="https://agentreplay.sritaraksolutions.in"
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-sm font-semibold text-brand underline"
        >
          Open AgentReplay’s separate demo ↗
        </a>
      </section>
    </>
  );
};
