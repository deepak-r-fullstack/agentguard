/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  // First run downloads a MongoDB binary (~100 MB) for mongodb-memory-server.
  testTimeout: 60000,
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
};
