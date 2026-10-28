// Custom imports (env must load first so every other module sees the settings)
import { env } from "./config/env";
import { createApp } from "./app";
import { connectToDatabase, disconnectFromDatabase } from "./loaders/database";
import { logger, serializeError } from "./utils/logger";
import { Workspace } from "./models/workspace.model";
import { seedDemoData } from "./services/demo/demo.service";

// Unhandled rejections and uncaught exceptions: log, then exit so the platform
// restarts a clean process instead of serving with corrupted state.
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", serializeError(reason));
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", serializeError(err));
  process.exit(1);
});

async function startServer() {
  try {
    await connectToDatabase();

    // A fresh hosted database (Render + Atlas) gets the demo data automatically.
    if (env.SEED_ON_START && (await Workspace.estimatedDocumentCount()) === 0) {
      await seedDemoData();
      logger.info("demo data created on first start");
    }

    const app = createApp();
    const server = app.listen(env.PORT, () => {
      logger.info("server listening", { port: env.PORT, environment: env.NODE_ENV, demoMode: env.DEMO_MODE });
    });

    const shutdown = (signal: string) => {
      logger.info("shutting down", { signal });
      server.close(async () => {
        await disconnectFromDatabase();
        process.exit(0);
      });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    logger.error("startServer failed", serializeError(err));
    console.error("\nCould not start AgentGuard. Is MongoDB running? Check MONGO_URI in server/env/local.env.\n");
    process.exit(1);
  }
}

startServer();
