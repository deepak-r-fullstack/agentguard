// Runs before any test file is loaded, so config/env.ts sees test settings.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-at-least-16-chars";
process.env.LLM_PROVIDER = "none";
process.env.DEMO_MODE = "true";
