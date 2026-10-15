// Browser end-to-end test: two real Chrome sessions (Alice, Bob) with fake camera/mic
// drive the built client against a fresh server. Screenshots land in E2E_SHOTS.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright-core";

const PORT = 4998;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.E2E_SHOTS ?? path.join(tmpdir(), "teams-e2e-shots");
mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const srv = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), TEAMS_DATA_DIR: mkdtempSync(path.join(tmpdir(), "teams-e2e-")) },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise<void>((r) => srv.stdout!.on("data", (d) => String(d).includes("server on") && r()));

let failures = 0;
async function step(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e: any) {
    failures++;
    console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").slice(0, 8).join("\n      ")}`);
    await Promise.all([shot(alice, `fail-${failures}-alice`), shot(bob, `fail-${failures}-bob`)]).catch(() => {});
    if (process.env.E2E_STOP_ON_FAIL) throw e;
  }
}
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const ctx = async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera", "microphone"] });
  return c.newPage();
};
const alice = await ctx();
const bob = await ctx();
for (const [p, who] of [[alice, "alice"], [bob, "bob"]] as const)
  p.on("pageerror", (e) => console.log(`  [${who} pageerror] ${e.message}`));

async function signup(p: Page, name: string, email: string) {
  await p.goto(BASE);
  await p.getByRole("button", { name: "Create an account" }).click();
  await p.getByLabel("Name").fill(name);
  await p.getByLabel("Email").fill(email);
  await p.getByLabel("Password").fill("demo123");
  await p.getByRole("button", { name: "Create account" }).click();
  await p.getByRole("navigation", { name: "Apps" }).waitFor();
}

try {
  await step("both users sign up and land in the app", async () => {
    await signup(alice, "Alice Johnson", "alice@e2e.dev");
    await signup(bob, "Bob Smith", "bob@e2e.dev");
  });

  await step("alice starts a 1:1 chat with bob and @mentions him", async () => {
    await alice.getByRole("button", { name: "New chat" }).click();
    await alice.getByPlaceholder("Search by name or email").fill("bob");
    await alice.getByRole("checkbox").first().check();
    await alice.getByRole("button", { name: "Start chat" }).click();
    const box = alice.getByLabel("Type a message");
    await box.fill("Hi @Bo");
    await alice.locator(".mention-option").first().click();
    await box.pressSequentially("can you review the **launch plan**?");
    await box.press("Enter");
    await alice.locator(".msg-content", { hasText: "launch plan" }).waitFor();
  });

  await step("bob gets the message live with unread badge, mention highlighted", async () => {
    await bob.locator(".list-item.unread", { hasText: "Alice Johnson" }).waitFor({ timeout: 5000 });
    await bob.locator(".list-item", { hasText: "Alice Johnson" }).click();
    await bob.locator(".mention-me", { hasText: "Bob Smith" }).waitFor();
    await bob.locator(".msg-content strong", { hasText: "launch plan" }).waitFor();
    await shot(bob, "01-bob-chat");
  });

  await step("typing indicator reaches alice", async () => {
    await bob.getByLabel("Type a message").pressSequentially("Sure, looking", { delay: 30 });
    await alice.getByText("Bob Smith is typing…").waitFor({ timeout: 5000 });
    await bob.getByLabel("Type a message").press("Enter");
    await alice.locator(".msg-content", { hasText: "Sure, looking" }).waitFor();
  });

  await step("reaction syncs to the other side", async () => {
    const msg = alice.locator(".msg", { hasText: "Sure, looking" });
    await msg.hover();
    await msg.getByRole("button", { name: "React 👍" }).click();
    await bob.locator(".reaction", { hasText: "👍 1" }).waitFor({ timeout: 5000 });
  });

  await step("bob's activity feed shows the mention", async () => {
    await bob.getByRole("navigation", { name: "Apps" }).getByRole("button", { name: "Activity" }).click();
    await bob.getByText("Alice Johnson mentioned you").waitFor({ timeout: 5000 });
    await bob.getByRole("navigation", { name: "Apps" }).getByRole("button", { name: "Chat" }).click();
  });

  await step("alice creates a team, adds bob, posts in General", async () => {
    await alice.getByRole("navigation", { name: "Apps" }).getByRole("button", { name: "Teams" }).click();
    await alice.getByRole("button", { name: "Create a team" }).click();
    await alice.getByLabel("Team name").fill("Design Crew");
    await alice.getByRole("button", { name: "Create", exact: true }).click();
    await alice.getByRole("heading", { name: "General" }).waitFor();
    await alice.getByRole("button", { name: "Add people to team" }).click();
    await alice.getByPlaceholder("Search by name or email").fill("bob");
    await alice.getByRole("checkbox").first().check();
    await alice.getByRole("button", { name: "Add", exact: true }).click();
    await alice.getByRole("button", { name: "Add a subject" }).click();
    await alice.getByPlaceholder("Add a subject").fill("Q3 roadmap");
    const box = alice.getByLabel("Start a new conversation. Type @ to mention someone.");
    await box.fill("Drafting milestones for the quarter");
    await box.press("Enter");
    await alice.locator(".msg-subject", { hasText: "Q3 roadmap" }).waitFor();
  });

  await step("bob sees the team, replies in the thread; alice gets it live", async () => {
    await bob.getByRole("navigation", { name: "Apps" }).getByRole("button", { name: "Teams" }).click();
    await bob.locator(".channel-item", { hasText: "General" }).click({ timeout: 5000 });
    await bob.getByRole("button", { name: "Reply" }).click();
    const r = bob.getByLabel("Reply", { exact: true });
    await r.fill("Adding the design review dates");
    await r.press("Enter");
    await alice.locator(".replies .msg-content", { hasText: "design review dates" }).waitFor({ timeout: 5000 });
    await shot(alice, "02-alice-channel");
  });

  await step("search finds the channel post", async () => {
    await bob.getByLabel("Search messages").fill("milest");
    await bob.getByLabel("Search messages").press("Enter");
    await bob.locator(".search-hit mark", { hasText: "milestones" }).waitFor({ timeout: 5000 });
    await shot(bob, "03-bob-search");
  });

  await step("alice video-calls bob; bob gets a ring and accepts", async () => {
    await alice.getByRole("navigation", { name: "Apps" }).getByRole("button", { name: "Chat" }).click();
    await alice.locator(".list-item", { hasText: "Bob Smith" }).click();
    await alice.getByRole("button", { name: "Video call" }).click();
    await bob.getByRole("alertdialog", { name: /Incoming call from Alice Johnson/ }).waitFor({ timeout: 8000 });
    await shot(bob, "04-bob-ringing");
    await bob.getByRole("button", { name: "Accept with video" }).click();
  });

  await step("media flows both ways (remote video decoding on each side)", async () => {
    const remotePlaying = (p: Page) => p.waitForFunction(() => {
      const vids = [...document.querySelectorAll<HTMLVideoElement>(".tile video:not(.mirrored)")];
      return vids.some((v) => v.videoWidth > 0 && v.readyState >= 2 && !v.paused);
    }, null, { timeout: 15000 });
    await Promise.all([remotePlaying(alice), remotePlaying(bob)]);
    await alice.waitForTimeout(1000);
    await shot(alice, "05-alice-in-call");
  });

  await step("presence shows In a call", async () => {
    const status = await bob.evaluate(async () => {
      const token = localStorage.getItem("teams-rebuild-token");
      const r = await fetch("/graphql", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: '{users(search:"alice"){presence}}' }) });
      return (await r.json()).data.users[0].presence;
    });
    if (status !== "InACall") throw new Error(`presence was ${status}`);
  });

  await step("hang up ends the call and posts a call-ended event", async () => {
    await alice.getByRole("button", { name: "Leave" }).click();
    await bob.getByRole("button", { name: "Leave" }).click();
    await alice.locator(".system-msg", { hasText: "Call ended" }).waitFor({ timeout: 5000 });
  });
} finally {
  await browser.close();
  srv.kill();
}
console.log(failures ? `\n${failures} step(s) failed — screenshots in ${SHOTS}` : `\nall steps passed — screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);
