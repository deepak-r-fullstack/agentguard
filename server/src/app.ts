// External imports
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";

// Custom imports
import { env } from "./config/env";
import routes from "./api/routes";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.middleware";

// The built React app (client/dist). When it exists, the API server also serves
// the website, so the whole product deploys as ONE service with ONE URL.
const CLIENT_BUILD_DIR = path.resolve(__dirname, "../../client/dist");

// Builds the Express app without starting it, so tests can use it with supertest.
export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // correct client IPs for rate limiting behind Render/Railway/ALB
  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim()), credentials: false }));
  app.use(express.json({ limit: "100kb" }));

  app.use("/api", routes);
  // Unknown /api addresses get a JSON 404, never the website.
  app.use("/api", notFoundHandler);

  if (fs.existsSync(path.join(CLIENT_BUILD_DIR, "index.html"))) {
    // Hashed asset files never change, so browsers may cache them for a year.
    app.use("/assets", express.static(path.join(CLIENT_BUILD_DIR, "assets"), { immutable: true, maxAge: "1y" }));
    app.use(express.static(CLIENT_BUILD_DIR, { index: false }));
    // Single-page app: every other address loads index.html and React Router takes over.
    app.get("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(CLIENT_BUILD_DIR, "index.html"));
    });
  }

  // Express picks error middleware by registration order: these stay last.
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
