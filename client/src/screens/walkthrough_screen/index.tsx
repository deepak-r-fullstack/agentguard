import { ReactNode, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { DisplayButton, DisplayError, DisplayPageHeader, DisplayStatusBadge } from "components/display_components";
import { useActionDecision, useActionDetail, useCompanyData, useGuidedRecording } from "utils/hooks/useAgentGuardQueries";
import { demoService } from "utils/services/api_services/agentguard_service";
import { getErrorMessage, isNotFoundError } from "utils/services/api_services/apiClient";
import { formatMoney } from "utils/helper_functions/format";
import { useAuthStore } from "utils/store/authStore";
import { GuidedRecordingStatus } from "utils/types";

// The guided booking journey: prepare a practice booking, let the agent ask to cancel it, see why AgentGuard waits for
// a person, approve, check the result, open the recording in AgentReplay, and undo it here.
// It uses the ordinary approve / undo endpoints. Each visitor gets a fresh booking instead of resetting data other
// visitors use. The booking and the action live in the address, so a refresh or a sign-in comes back to the same journey.

const UNSUCCESSFUL = ["denied", "expired", "rejected", "failed"];

// One id per "Prepare my booking" click. crypto.randomUUID needs a secure page, so there is a fallback.
function newAttemptId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type StepState = "done" | "current" | "upcoming";

const Step = ({ number, title, state, children }: { number: number; title: string; state: StepState; children?: ReactNode }) => (
  <li
    className={`rounded-lg border bg-sheet p-5 ${state === "current" ? "border-brand shadow-sm" : "border-line"} ${state === "upcoming" ? "opacity-60" : ""}`}
    aria-current={state === "current" ? "step" : undefined}
  >
    <h2 className="flex items-center gap-2 font-semibold">
      {state === "done" ? (
        <CheckCircle2 className="h-5 w-5 shrink-0 text-done" aria-label="Done" />
      ) : (
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${state === "current" ? "bg-brand text-white" : "bg-ink/10 text-ink-soft"}`}
          aria-hidden
        >
          {number}
        </span>
      )}
      <span>
        <span className="sr-only">Step {number}: </span>
        {title}
      </span>
    </h2>
    {state !== "upcoming" && children && <div className="mt-3 pl-8">{children}</div>}
  </li>
);

// The AgentReplay recording of this journey: on its way, ready to open, or not available (and why).
const RecordingPanel = ({ status, decided }: { status?: GuidedRecordingStatus; decided: boolean }) => {
  if (!decided || !status || status.state === "waiting") {
    return <p className="text-sm text-ink-soft">After you decide, AgentGuard saves this journey to AgentReplay, so you can replay it step by step.</p>;
  }
  if (status.state === "pending") {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-soft" role="status" data-testid="recording-state" data-state="pending">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> {status.message}
      </p>
    );
  }
  if (status.state === "available" && status.url) {
    return (
      <div data-testid="recording-state" data-state="available">
        <p className="text-sm" role="status">
          {status.message}
        </p>
        <a
          href={status.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-2 rounded-md bg-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-brand-dark"
        >
          View recording <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
        <p className="mt-2 text-xs text-ink-faint">Opens AgentReplay in a new tab. It shows what happened; Undo stays here in AgentGuard.</p>
      </div>
    );
  }
  return (
    <div data-testid="recording-state" data-state="unavailable">
      <p className="text-sm text-ink-soft" role="status">
        {status.message}
      </p>
      <a href="https://agentreplay.sritaraksolutions.in" target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-ink-faint underline">
        AgentReplay’s own sample story (not your booking) ↗
      </a>
    </div>
  );
};

export const WalkthroughScreen = () => {
  const user = useAuthStore((state) => state.user);
  const [searchParams, setSearchParams] = useSearchParams();
  const bookingCode = searchParams.get("booking") || "";
  const actionId = searchParams.get("action");
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  // Kept after a failed click, so trying again reuses the same attempt (and finds the booking if it was made after all).
  const attemptRef = useRef<string | null>(null);
  const approve = useActionDecision("approve");
  const undo = useActionDecision("undo");
  const { data: action, error: actionError } = useActionDetail(actionId);
  const { data: company, refetch: refreshCompany } = useCompanyData();
  const decided = Boolean(action && action.status !== "pending_approval" && action.status !== "executing");
  const { data: recording } = useGuidedRecording(action?.guidedDemo && decided ? action.id : null);
  const booking = company?.bookings.find((item) => item.code === bookingCode);
  const busy = starting || asking || approve.isPending || undo.isPending;

  const setJourney = (next: { booking?: string; action?: string }) => {
    const params = new URLSearchParams();
    if (next.booking) params.set("booking", next.booking);
    if (next.action) params.set("action", next.action);
    setSearchParams(params, { replace: true });
  };

  const start = async () => {
    setError("");
    setStarting(true);
    attemptRef.current = attemptRef.current || newAttemptId();
    try {
      const response = await demoService.startWalkthrough(attemptRef.current);
      attemptRef.current = null;
      setJourney({ booking: response.data.bookingCode });
      await refreshCompany();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  // Safe to press again: the same booking always gives back the same request.
  const request = async () => {
    setError("");
    setAsking(true);
    try {
      const response = await demoService.requestGuidedCancellation(bookingCode);
      setJourney({ booking: bookingCode, action: response.data.id });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAsking(false);
    }
  };

  // Which steps are finished, which need the visitor now, and which come later. After approval, the recording (5) and
  // Undo (6) are both available at once; after Undo everything is finished.
  const stepOf = (number: number): StepState => {
    if (action?.status === "undone") return "done";
    if (action?.status === "done") return number <= 4 ? "done" : "current";
    const current = !bookingCode ? 1 : !actionId ? 2 : 3;
    if (number < current) return "done";
    return number === current ? "current" : "upcoming";
  };
  const finished = action?.status === "undone" && booking?.status === "confirmed" && booking.refundAmount === 0;

  return (
    <>
      <DisplayPageHeader
        title="Approve it. Inspect it. Undo it."
        description="Follow one booking from an AI agent's request to your approval, its recording, and Undo. It uses practice data: no emails or payments leave this demo."
      />
      <p className="mb-6 max-w-2xl text-sm text-ink-soft">
        Each attempt creates its own booking. Company rules and daily limits are shared with other visitors, so a busy demo may refuse a request; starting again never
        resets anyone else’s data.
      </p>
      {error && <DisplayError message={error} />}
      {actionId && isNotFoundError(actionError) && (
        <div className="mb-4">
          <DisplayError message="We could not find that journey in your company. Start a new one below." />
        </div>
      )}

      <ol className="grid max-w-3xl gap-3">
        <Step number={1} title="Start a sample booking" state={stepOf(1)}>
          <p className="text-sm text-ink-soft">We create a confirmed practice booking for ₹7,500, just for you. That is above the amount the agent may refund on its own.</p>
          {!bookingCode && (
            <div className="mt-3">
              <DisplayButton variant="primary" loading={starting} disabled={busy} onClick={start}>
                Prepare my booking
              </DisplayButton>
            </div>
          )}
          {bookingCode && (
            <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm" aria-live="polite">
              <dt className="text-ink-faint">Booking</dt>
              <dd className="break-all font-medium" data-testid="booking-code">
                {bookingCode}
              </dd>
              <dt className="text-ink-faint">Status</dt>
              <dd data-testid="booking-status">{booking?.status || "Loading…"}</dd>
              <dt className="text-ink-faint">Refund</dt>
              <dd data-testid="booking-refund">{booking ? formatMoney(booking.refundAmount) : "—"}</dd>
            </dl>
          )}
        </Step>

        <Step number={2} title="The AI agent asks to cancel it" state={stepOf(2)}>
          <p className="text-sm text-ink-soft">A support agent (an AI) asks AgentGuard to cancel the booking and refund the customer.</p>
          {!actionId && (
            <div className="mt-3">
              <DisplayButton variant="primary" loading={asking} disabled={busy || !bookingCode} onClick={request}>
                Request cancellation
              </DisplayButton>
            </div>
          )}
        </Step>

        <Step number={3} title="AgentGuard explains why it needs you" state={stepOf(3)}>
          {action && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <DisplayStatusBadge status={action.status} />
                {action.status === "pending_approval" && <span className="text-sm text-ink-soft">Nothing has changed yet. The booking waits for a person.</span>}
              </div>
              <div className="mt-3 rounded-md border border-waiting/30 bg-waiting-tint px-4 py-3 text-sm">
                <p className="font-semibold text-ink">Why a person must decide</p>
                <ul className="mt-1 list-disc pl-5 text-ink-soft" data-testid="approval-reasons">
                  {action.decisionReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
              {action.status === "pending_approval" && (
                <div className="mt-3">
                  <DisplayButton variant="primary" loading={approve.isPending} disabled={busy} onClick={() => approve.mutate({ id: action.id })}>
                    Approve cancellation
                  </DisplayButton>
                  <p className="mt-2 text-xs text-ink-faint">You approve as {user?.name}. AgentGuard then cancels the booking for the agent.</p>
                </div>
              )}
              {action.errorMessage && <p className="mt-3 text-sm text-refused">{action.errorMessage}</p>}
            </>
          )}
        </Step>

        <Step number={4} title="See the result" state={stepOf(4)}>
          {action?.status === "done" && booking?.status === "cancelled" && (
            <p className="text-sm" role="status">
              <span className="font-semibold">Cancelled.</span> The customer was refunded {formatMoney(booking.refundAmount)} (practice money).
            </p>
          )}
          {action?.status === "undone" && <p className="text-sm text-ink-soft">The booking was cancelled, then you undid it (see step 6).</p>}
        </Step>

        <Step number={5} title="Watch the recording" state={stepOf(5)}>
          <RecordingPanel status={recording} decided={decided} />
        </Step>

        <Step number={6} title="Undo it" state={stepOf(6)}>
          <p className="text-sm text-ink-soft">Changed your mind? Undo puts the booking back exactly as it was. Only managers and admins can undo, and it is logged with your name.</p>
          {action?.canUndo && (
            <div className="mt-3">
              <DisplayButton variant="primary" loading={undo.isPending} disabled={busy} onClick={() => undo.mutate({ id: action.id })}>
                Undo cancellation
              </DisplayButton>
            </div>
          )}
          {finished && (
            <p role="status" className="mt-3 text-sm font-semibold text-done">
              Restored. The booking is confirmed again and its refund is back to ₹0.
            </p>
          )}
        </Step>
      </ol>

      {action && UNSUCCESSFUL.includes(action.status) && (
        <div className="mt-5 max-w-3xl rounded-lg border border-line bg-sheet p-5">
          <p className="text-sm text-ink-soft">This request did not complete, so the booking was not changed. Its history explains why. You can start again with a new booking.</p>
        </div>
      )}

      <div className="mt-6 flex max-w-3xl flex-wrap items-center gap-4">
        {actionId && (
          <Link to={`/activity?action=${encodeURIComponent(actionId)}`} className="text-sm font-semibold text-brand underline">
            Inspect full action history →
          </Link>
        )}
        {bookingCode && (finished || (action && UNSUCCESSFUL.includes(action.status)) || isNotFoundError(actionError)) && (
          <DisplayButton disabled={busy} onClick={() => setJourney({})}>
            Start another walkthrough
          </DisplayButton>
        )}
      </div>
    </>
  );
};
