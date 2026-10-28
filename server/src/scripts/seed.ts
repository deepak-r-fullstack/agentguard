import { connectToDatabase, disconnectFromDatabase } from "../loaders/database";
import { DEMO_COMPANIES, DEMO_PASSWORD, seedDemoData } from "../services/demo/demo.service";

// npm run seed  ->  wipes the demo companies and creates them fresh.

async function main() {
  await connectToDatabase();
  const result = await seedDemoData();

  console.log("\n✅ Demo data is ready.\n");
  console.log("Sign in at http://localhost:5173 with any of these (password for all: " + DEMO_PASSWORD + "):");
  for (const company of DEMO_COMPANIES) {
    for (const user of company.users) {
      console.log(`  ${company.name.padEnd(16)} ${user.role.padEnd(8)} ${user.email}`);
    }
  }
  console.log("\nAgent API keys (shown once — copy the one you need for curl or your own agent):");
  for (const key of result.agentKeys) {
    console.log(`  ${key.workspace.padEnd(16)} ${key.agentName.padEnd(18)} ${key.apiKey}`);
  }
  console.log("");
  await disconnectFromDatabase();
}

main().catch(async (err) => {
  console.error("Seeding failed:", err instanceof Error ? err.message : err);
  await disconnectFromDatabase().catch(() => undefined);
  process.exit(1);
});
