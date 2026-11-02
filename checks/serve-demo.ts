// Disposable local database for browser checks. Never uses the hosted database.
import { createApp } from "../server/src/app";
import { startTestDb, stopTestDb } from "../server/tests/helpers/testDb";
import { seedDemoData } from "../server/src/services/demo/demo.service";

async function main() {
  await startTestDb();
  await seedDemoData();
  const server = createApp().listen(Number(process.env.LOCAL_BROWSER_PORT || 4181), "127.0.0.1");
  const shutdown = () =>
    server.close(() => {
      void stopTestDb().then(() => process.exit(0));
    });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch(() => {
  console.error("Local demo setup failed.");
  process.exit(1);
});
