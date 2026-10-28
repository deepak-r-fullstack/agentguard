import mongoose from "mongoose";
import { env } from "../config/env";
import { logger, serializeError } from "../utils/logger";

export async function connectToDatabase(uri = env.MONGO_URI) {
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
    logger.info("database connected", { database: mongoose.connection.name });
  } catch (err) {
    logger.error("database connection failed", serializeError(err));
    throw err;
  }
}

export async function disconnectFromDatabase() {
  await mongoose.disconnect();
}
