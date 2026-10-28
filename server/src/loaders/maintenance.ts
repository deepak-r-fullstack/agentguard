import { logger, serializeError } from "../utils/logger";
import { recoverInterruptedActions } from "../services/actions/recovery.service";
import { expireOverdueApprovals } from "../services/approvals/approvalExpiry.service";

// Background jobs. They run once at startup and then on a timer. Every step they take is an atomic
// conditional update, so any number of server instances can run them at the same time.
const RECOVERY_EVERY_MS = 5 * 60 * 1000;
const EXPIRY_EVERY_MS = 60 * 1000;

function guarded(name: string, job: () => Promise<number>) {
  return async () => {
    try {
      const count = await job();
      if (count > 0) logger.info(`${name} finished`, { count });
    } catch (err) {
      // A failed run is simply tried again on the next tick.
      logger.error(`${name} failed`, serializeError(err));
    }
  };
}

/** Starts the jobs and returns a function that stops them. */
export function startMaintenanceJobs() {
  const recover = guarded("recovery of interrupted actions", () => recoverInterruptedActions());
  const expire = guarded("expiry of old approvals", () => expireOverdueApprovals());

  void recover();
  void expire();
  // unref: a pending timer alone never keeps the process alive.
  const timers = [setInterval(recover, RECOVERY_EVERY_MS).unref(), setInterval(expire, EXPIRY_EVERY_MS).unref()];
  return () => timers.forEach((timer) => clearInterval(timer));
}
