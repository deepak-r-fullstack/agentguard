import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const port = process.env.LOCAL_BROWSER_PORT || "4181";
const url = "http://127.0.0.1:" + port;
const child = spawn(process.execPath, ["--import", "tsx", "checks/serve-demo.ts"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    DEMO_MODE: "true",
    JWT_SECRET: "browser-test-secret-only",
    // A local MongoDB (for example mongodb://127.0.0.1:27017) when the in-memory one cannot be downloaded. Each run uses its own database and drops it.
    TEST_MONGO_URI: process.env.TEST_MONGO_URI || "",
    AGENTREPLAY_API_KEY: "",
    GITHUB_SANDBOX_TOKEN: "",
    LOCAL_BROWSER_PORT: port
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
child.stdout.on("data", (data) => (serverOutput += data));
child.stderr.on("data", (data) => (serverOutput += data));
let browser;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      ready = (await fetch(url + "/api/health")).ok;
    } catch {}
    if (ready) break;
    if (child.exitCode !== null) throw new Error(serverOutput);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, "Local server must start");
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const dir = "checks/screenshots/" + name;
    await mkdir(dir, { recursive: true });
    await page.goto(url + "/walkthrough");
    await page.getByRole("button", { name: /Karan Shah, Manager/ }).click();
    await page.getByRole("heading", { name: "Approve it. Inspect it. Undo it." }).waitFor();
    await page.getByRole("button", { name: "Prepare my booking" }).click();
    await page.getByTestId("booking-code").waitFor();
    const code = await page.getByTestId("booking-code").textContent();
    assert.ok(code.startsWith("DEMO-"));
    await page.getByTestId("booking-status").filter({ hasText: "confirmed" }).waitFor();
    await page.screenshot({ path: dir + "/prepared.png", fullPage: true });
    await page.getByRole("button", { name: "Request cancellation" }).click();
    await page.getByRole("button", { name: "Approve cancellation" }).waitFor();
    assert.equal(await page.getByTestId("booking-status").textContent(), "confirmed");
    await page.screenshot({ path: dir + "/waiting.png", fullPage: true });
    await page.getByRole("button", { name: "Approve cancellation" }).click();
    await page.getByRole("button", { name: "Undo cancellation" }).waitFor();
    await page.getByTestId("booking-status").filter({ hasText: "cancelled" }).waitFor();
    await page.getByTestId("booking-refund").filter({ hasText: "₹7,500" }).waitFor();
    await page.screenshot({ path: dir + "/cancelled.png", fullPage: true });
    await page.getByRole("button", { name: "Undo cancellation" }).click();
    await page.getByRole("status").filter({ hasText: "Restored." }).waitFor();
    assert.equal(await page.getByTestId("booking-status").textContent(), "confirmed");
    assert.equal(await page.getByTestId("booking-refund").textContent(), "₹0");
    await page.screenshot({ path: dir + "/restored.png", fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No sideways overflow");
    await page.getByRole("link", { name: /Inspect full action history/ }).click();
    await page.getByRole("dialog", { name: "Action details" }).waitFor();
    await page.getByText("Undid:", { exact: false }).waitFor();
    await page.screenshot({ path: dir + "/history.png", fullPage: true });
    await page.reload();
    await page.getByRole("dialog", { name: "Action details" }).waitFor();
    assert.deepEqual(errors, [], "No browser errors");
    console.log(name + ": booking, approval, cancellation, undo, history and deep-link refresh passed");
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000).unref();
    }
  });
}
