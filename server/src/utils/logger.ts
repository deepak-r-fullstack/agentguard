// Small structured logger (JSON lines). Same rule as the NueAssist logging standard:
// log opaque ids and structure only. Never log action params, emails, names,
// free-text reasons, tokens or request bodies — they can carry personal data.

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, string | number | boolean | null | undefined>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: LogLevel = process.env.NODE_ENV === "test" ? "error" : "info";

function write(level: LogLevel, message: string, fields: LogFields = {}) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: "agentguard-server",
    message,
    ...fields,
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message };
  }
  return { errorMessage: String(err) };
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};
