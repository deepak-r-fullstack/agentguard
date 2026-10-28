import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Uses an in-memory MongoDB that mongodb-memory-server downloads on first run.
// Set TEST_MONGO_URI to use an existing MongoDB instead (for example a CI service).
let memoryServer: MongoMemoryServer | null = null;

export async function startTestDb() {
  let uri = process.env.TEST_MONGO_URI;
  if (!uri) {
    memoryServer = await MongoMemoryServer.create();
    uri = memoryServer.getUri();
  }
  const dbName = `agentguard_test_${process.pid}_${Date.now()}`;
  await mongoose.connect(uri, { dbName });
  // Build unique indexes now; the idempotency tests depend on them.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function stopTestDb() {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
}
