import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { z } from "zod";

// Load env/<NODE_ENV>.env when it exists (same convention as the NueAssist services).
// Values already set in the real environment always win, so production never reads a file.
const NODE_ENV = (process.env.NODE_ENV || "local").toLowerCase();
const envFile = path.join(process.cwd(), "env", `${NODE_ENV}.env`);
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
}

const DEV_JWT_SECRET = "agentguard-dev-only-secret-change-me";

const envSchema = z.object({
  NODE_ENV: z.string().default("local"),
  PORT: z.coerce.number().int().positive().default(5050),
  MONGO_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/agentguard"),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  JWT_EXPIRES_IN: z.string().default("8h"),
  LLM_PROVIDER: z.enum(["none", "openai", "anthropic", "ollama"]).default("none"),
  LLM_MODEL: z.string().optional().default(""),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_BASE_URL: z.string().optional().default(""),
  // Slack approvals are optional: with either value missing, the feature stays off.
  SLACK_BOT_TOKEN: z.string().optional().default(""),
  SLACK_SIGNING_SECRET: z.string().optional().default(""),
  // Demo mode turns on the "reset demo data" button and the agent playground.
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  // Hosted demo: create the demo companies on first start when the database is empty.
  SEED_ON_START: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast at boot with a readable list instead of a confusing error later.
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV.toLowerCase() === "production";
export const isTest = env.NODE_ENV.toLowerCase() === "test";

if (isProduction && env.JWT_SECRET === DEV_JWT_SECRET) {
  console.error("JWT_SECRET must be set in production.");
  process.exit(1);
}
