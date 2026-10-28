import { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import { STATUS_META } from "utils/helper_functions/format";
import { useToastStore } from "utils/store/toastStore";
import { ActionStatus } from "utils/types";

// Shared building blocks, like components/display_components in the NueAssist UI.

// ---------- Button ----------

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-dark disabled:bg-brand/50",
  secondary: "border border-line bg-sheet text-ink hover:border-ink-faint disabled:text-ink-faint",
  danger: "border border-refused/30 bg-sheet text-refused hover:bg-refused-tint disabled:opacity-50",
  ghost: "text-ink-soft hover:bg-ink/5 hover:text-ink disabled:opacity-50",
};

interface DisplayButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
}

export const DisplayButton = ({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...props
}: DisplayButtonProps) => {
  const sizeStyle = size === "lg" ? "px-5 py-2.5 text-base" : "px-3.5 py-1.5 text-sm";
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed ${sizeStyle} ${BUTTON_STYLES[variant]} ${className}`}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
};

// ---------- Status badge ----------

const TONE_STYLES = {
  done: "bg-done-tint text-done",
  waiting: "bg-waiting-tint text-waiting",
  refused: "bg-refused-tint text-refused",
  undone: "bg-undone-tint text-undone",
  neutral: "bg-ink/5 text-ink-soft",
};

export const DisplayStatusBadge = ({ status }: { status: ActionStatus }) => {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_STYLES[meta.tone]}`}>
      {meta.label}
    </span>
  );
};

// ---------- Page header ----------

export const DisplayPageHeader = ({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) => (
  <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="mt-1 text-ink-soft">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
  </header>
);

// ---------- Empty, loading and error states ----------

export const DisplayEmptyState = ({ title, description, action }: { title: string; description: string; action?: ReactNode }) => (
  <div className="rounded-lg border border-dashed border-line bg-sheet px-6 py-12 text-center">
    <p className="font-serif text-lg">{title}</p>
    <p className="mx-auto mt-1 max-w-md text-ink-soft">{description}</p>
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const DisplayLoading = ({ label = "Loading" }: { label?: string }) => (
  <div className="flex items-center gap-2 py-10 text-ink-soft" role="status">
    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
    {label}…
  </div>
);

export const DisplayError = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="rounded-lg border border-refused/30 bg-refused-tint px-4 py-3 text-refused" role="alert">
    <p>{message}</p>
    {onRetry && (
      <button type="button" onClick={onRetry} className="mt-1 text-sm font-semibold underline">
        Try again
      </button>
    )}
  </div>
);

// ---------- Toasts ----------

const TOAST_STYLES = {
  success: "border-done/30 bg-sheet text-ink [&>span]:bg-done",
  error: "border-refused/40 bg-sheet text-ink [&>span]:bg-refused",
  info: "border-line bg-sheet text-ink [&>span]:bg-brand",
};

export const DisplayToasts = () => {
  const { toasts, dismissToast } = useToastStore();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg shadow-ink/5 ${TOAST_STYLES[toast.tone]}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          <span className="mt-2 h-2 w-2 shrink-0 rounded-full" aria-hidden />
          <p className="flex-1 text-sm">{toast.message}</p>
          <button type="button" onClick={() => dismissToast(toast.id)} className="text-ink-faint hover:text-ink" aria-label="Close message">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
};
