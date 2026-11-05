// The whole guided journey across BOTH products, in a real browser, on desktop and phone:
//   AgentGuard: sign in -> practice booking -> agent asks -> why approval is needed -> approve -> result -> recording ready
//   AgentReplay: "View recording" -> sign-in keeps the link -> "Try the demo" -> that exact run, linked to the action
//   AgentGuard: "Open this action" -> Undo in the action's details -> back to the guided demo, restored
// Also checks that a signed-out visitor following AgentReplay's link lands on the same action after signing in.
//
// Needs a local AgentReplay checkout and a MongoDB both apps can use (each run uses fresh databases and drops them):
//   npm --prefix ../agent_replay run build -w client
//   AGENTREPLAY_DIR=../agent_replay TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run check:linked-journey
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { chromium } from "playwright";

const replayDir = path.resolve(process.env.AGENTREPLAY_DIR || "../agent_replay");
const mongoBase = (process.env.TEST_MONGO_URI || "").replace(/\/+$/, "");
assert.ok(mongoBase, "Set TEST_MONGO_URI to a MongoDB both apps can use, for example mongodb://127.0.0.1:27017");
assert.ok(existsSync(path.join(replayDir, "client/dist/index.html")), `Build AgentReplay's website first: npm --prefix ${replayDir} run build -w client`);

// "localhost" (not 127.0.0.1): outside production, both products accept http:// links only for localhost.
const guardPort = process.env.GUARD_PORT || "4182";
const replayPort = process.env.REPLAY_PORT || "5062";
const guardUrl = `http://localhost:${guardPort}`;
const replayUrl = `http://localhost:${replayPort}`;
// A throwaway SDK key: AgentGuard records with it, AgentReplay's demo holds the matching linked app.
const sdkKey = `ar_${crypto.randomBytes(24).toString("hex")}`;
const replayDb = `${mongoBase}/agentreplay_linked_check_${process.pid}_${Date.now()}`;

const children = [];
function start(name, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  children.push({ name, child, output: () => output });
  return child;
}

async function waitForHealth(url, child, name) {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(url + "/api/health")).ok) return;
    } catch {}
    if (child.exitCode !== null) throw new Error(`${name} stopped:\n${children.find((item) => item.child === child).output()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not start`);
}

const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

let browser;
try {
  start("AgentReplay", process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.join(replayDir, "server"),
    env: {
      ...process.env,
      NODE_ENV: "check",
      PORT: replayPort,
      MONGO_URI: replayDb,
      JWT_SECRET: "linked-check-secret-only-for-this-run",
      CLIENT_ORIGIN: replayUrl,
      DEMO_MODE: "true",
      DEMO_AUTO_RESET: "true",
      AGENTGUARD_DEMO_URL: guardUrl,
      AGENTGUARD_DEMO_SDK_KEY: sdkKey,
      LLM_PROVIDER: "demo",
    },
  });
  const guard = start("AgentGuard", process.execPath, ["--import", "tsx", "checks/serve-demo.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      DEMO_MODE: "true",
      JWT_SECRET: "linked-check-secret-only-for-this-run",
      TEST_MONGO_URI: mongoBase,
      CLIENT_ORIGIN: guardUrl,
      AGENTREPLAY_API_KEY: sdkKey,
      AGENTREPLAY_URL: replayUrl,
      GITHUB_SANDBOX_TOKEN: "",
      LOCAL_BROWSER_PORT: guardPort,
    },
  });
  await waitForHealth(replayUrl, children[0].child, "AgentReplay");
  await waitForHealth(guardUrl, guard, "AgentGuard");
  // The demo workspace (and its linked app) is made on the first "Try the demo"; do it once so recording can start.
  assert.equal((await fetch(replayUrl + "/api/auth/demo", { method: "POST" })).status, 200);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  for (const [name, device] of Object.entries({
    desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  })) {
    const context = await browser.newContext({ ...device, reducedMotion: "reduce" });
    const errors = [];
    context.on("page", (page) => {
      page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
      page.on("console", (message) => message.type() === "error" && errors.push(`${page.url()}: ${message.text()}`));
    });
    const dir = "checks/screenshots/linked-journey/" + name;
    await mkdir(dir, { recursive: true });
    const shot = (page, file) => page.screenshot({ path: `${dir}/${file}.png`, fullPage: true });

    // 1. AgentGuard: signed out, the walkthrough link survives sign-in.
    const guardPage = await context.newPage();
    await guardPage.goto(guardUrl + "/walkthrough");
    await guardPage.getByRole("button", { name: /Karan Shah, Manager/ }).click();
    await guardPage.getByRole("heading", { name: "Approve it. Inspect it. Undo it." }).waitFor();
    assert.match(guardPage.url(), /\/walkthrough$/);

    await guardPage.getByRole("button", { name: "Prepare my booking" }).click();
    await guardPage.getByTestId("booking-status").filter({ hasText: "confirmed" }).waitFor();
    const bookingCode = (await guardPage.getByTestId("booking-code").textContent()).trim();
    assert.match(bookingCode, /^DEMO-[A-Z2-9]{10}$/);
    // The journey is in the address, so a refresh keeps it.
    await guardPage.reload();
    await guardPage.getByTestId("booking-code").filter({ hasText: bookingCode }).waitFor();

    // 2-3. The agent asks; AgentGuard explains why a person must decide.
    await guardPage.getByRole("button", { name: "Request cancellation" }).click();
    await guardPage.getByTestId("approval-reasons").filter({ hasText: "Big cancellations need a manager" }).waitFor();
    assert.equal(await guardPage.getByTestId("booking-status").textContent(), "confirmed");
    await shot(guardPage, "1-approval-needed");

    // 4. Approve and see the result.
    await guardPage.getByRole("button", { name: "Approve cancellation" }).click();
    await guardPage.getByText("Cancelled.", { exact: false }).waitFor();
    await guardPage.getByTestId("booking-refund").filter({ hasText: "7,500" }).waitFor();
    // 5. The recording is pending, then confirmed by AgentReplay.
    await guardPage.locator('[data-testid="recording-state"][data-state="available"]').waitFor({ timeout: 30_000 });
    await shot(guardPage, "2-result-and-recording");
    assert.ok(await noSidewaysScroll(guardPage), "AgentGuard walkthrough: no sideways scrolling");
    const actionId = new URL(guardPage.url()).searchParams.get("action");
    assert.match(actionId, /^[a-f0-9]{24}$/);

    // AgentReplay: the link opens a sign-in that keeps the destination and says what to press.
    const [replayPage] = await Promise.all([context.waitForEvent("page"), guardPage.getByRole("link", { name: "View recording" }).click()]);
    await replayPage.getByText("You are opening a recording.", { exact: false }).waitFor();
    assert.match(replayPage.url(), /\/runs\?externalId=/);
    await shot(replayPage, "3-replay-sign-in");
    await replayPage.getByRole("button", { name: "Try the demo" }).click();
    // The exact recording opens by itself: this booking, four steps, linked to this action.
    await replayPage.waitForURL(/\/runs\/[a-f0-9]{24}$/);
    await replayPage.getByRole("heading", { name: `Guided demo: cancel booking ${bookingCode}` }).waitFor();
    await replayPage.getByText("This recording comes from AgentGuard.", { exact: false }).waitFor();
    for (const step of ["Agent asks to cancel the booking", "AgentGuard checks the company rules", "A manager approves in AgentGuard", "AgentGuard cancels the booking"]) {
      await replayPage.getByRole("button", { name: new RegExp(step) }).waitFor();
    }
    await shot(replayPage, "4-recording");
    assert.ok(await noSidewaysScroll(replayPage), "AgentReplay run: no sideways scrolling");

    // Back to AgentGuard from the recording: the same action, with Undo right there.
    const actionLink = replayPage.getByRole("link", { name: "Open this action in AgentGuard" });
    assert.equal(await actionLink.getAttribute("href"), `${guardUrl}/activity?action=${actionId}`);
    const [actionPage] = await Promise.all([context.waitForEvent("page"), actionLink.click()]);
    const details = actionPage.getByRole("dialog", { name: "Action details" });
    await details.getByText(bookingCode, { exact: false }).first().waitFor();
    await details.getByRole("button", { name: "Undo this action" }).click();
    await details.getByRole("button", { name: "Yes, undo it" }).waitFor();
    await actionPage.waitForTimeout(400); // let the button's colour change finish before the picture
    await shot(actionPage, "5-action-in-agentguard");
    await details.getByRole("button", { name: "Yes, undo it" }).click();
    await details.getByText("Undone by Karan Shah.", { exact: false }).waitFor();
    await shot(actionPage, "6-undone");

    await details.getByRole("link", { name: "Back to the guided demo" }).click();
    await actionPage.getByRole("status").filter({ hasText: "Restored." }).waitFor();
    assert.equal(await actionPage.getByTestId("booking-status").textContent(), "confirmed");
    assert.equal(await actionPage.getByTestId("booking-refund").textContent(), "₹0");
    await shot(actionPage, "7-restored");
    assert.ok(await noSidewaysScroll(actionPage), "AgentGuard after undo: no sideways scrolling");

    // A signed-out visitor following the recording's link lands on the same action after signing in.
    const fresh = await browser.newContext({ ...device, reducedMotion: "reduce" });
    const signedOut = await fresh.newPage();
    await signedOut.goto(`${guardUrl}/activity?action=${actionId}`);
    await signedOut.getByRole("button", { name: /Karan Shah, Manager/ }).click();
    await signedOut.getByRole("dialog", { name: "Action details" }).getByText("Undone by Karan Shah.", { exact: false }).waitFor();
    await fresh.close();

    assert.deepEqual(errors, [], "No browser errors");
    console.log(`${name}: booking, approval reason, approval, recording, AgentReplay sign-in, exact run, link back, undo and sign-in redirect passed`);
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  for (const { child } of children) child.kill("SIGTERM");
  await Promise.all(
    children.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", resolve);
          setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5000).unref();
        })
    )
  );
  // AgentGuard's serve-demo drops its own database; drop AgentReplay's here.
  await mongoose
    .connect(replayDb)
    .then(() => mongoose.connection.dropDatabase())
    .catch(() => undefined)
    .finally(() => mongoose.disconnect());
}
