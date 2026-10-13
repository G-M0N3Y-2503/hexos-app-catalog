import type { HookContext } from "../_lib/hook_context";

// PhotoStructure's first run is a short chain of pages, each a form that redirects back to "/":
//   /welcome        Continue
//   /welcome/tools  whether PhotoStructure may download ffmpeg (answered "no" here; the separate
//                   install-photostructure-tools hook says yes only when the owner turns it on,
//                   since yes accepts responsibility for patent licences)
//   (plan picker)   on account.photostructure.com, skipped by PS_PICK_PLAN_ON_WELCOME=false
//   /settings       Start, which accepts the EULA; submitted with PhotoStructure's own defaults
// Once setup is done, "/" stops redirecting to any of them.

const MAX_STEPS = 8;
const TOOLS_POLL_MS = 10000;
const TOOLS_INSTALL_LIMIT_MS = 13 * 60 * 1000;
const STEP_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;

type Step = { kind: "done" } | { kind: "page"; path: string } | { kind: "external"; location: string };

export async function afterInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "appReady", message: "Starting PhotoStructure" },
    { id: "setupComplete", message: "Completing first-run setup" },
    { id: "verified", message: "Verifying web UI" },
  ]);

  // /ping is the endpoint the TrueNAS app's own healthcheck uses.
  await ctx.waitForApp("/ping", {
    maxAttempts: 50,
    initialDelayMs: 10000,
    maxDelayMs: 15000,
  });
  await ctx.emitCheckpoint("appReady", "PhotoStructure is running");

  const cookies = new Map<string, string>();
  let step = await currentStep(ctx, cookies);
  if (step.kind === "done") {
    ctx.log("First-run setup already completed, skipping.");
    await ctx.emitCheckpoint("setupComplete", "Already set up");
  } else {
    for (let i = 0; i < MAX_STEPS && step.kind === "page"; i++) {
      await submitPage(ctx, cookies, step.path);
      step = await currentStep(ctx, cookies);
    }
    if (step.kind === "external") {
      ctx.fail("PhotoStructure sent setup to a page outside the server.", [
        { label: "Location", value: step.location },
        { label: "Suggestion", value: "Open PhotoStructure and finish the welcome pages; your photos are untouched" },
      ]);
    }
    if (step.kind !== "done") {
      ctx.fail("PhotoStructure's first-run setup did not finish.", [
        { label: "Stuck on", value: step.path },
        { label: "Suggestion", value: "Open PhotoStructure and finish the welcome pages; your photos are untouched" },
      ]);
    }
    await ctx.emitCheckpoint("setupComplete", "Setup completed, EULA accepted");
  }

  const library = await fetch(`${ctx.baseUrl}/`, { headers: cookieHeader(cookies), signal: AbortSignal.timeout(10000) });
  if (!library.ok) {
    ctx.fail("PhotoStructure finished setup but its library page did not load.", [
      { label: "Endpoint", value: `GET ${ctx.baseUrl}/ (${library.status})` },
    ]);
  }
  await ctx.emitCheckpoint("verified", "PhotoStructure is ready");
}

/** Where "/" sends a visitor right now: a setup page, a page off the server, or nowhere (done). */
async function currentStep(ctx: HookContext, cookies: Map<string, string>): Promise<Step> {
  for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt++) {
    try {
      // Only "/" leading into a setup page matters; any other page means setup is behind us.
      let path = "/";
      for (let hop = 0; hop < 5; hop++) {
        const resp = await request(ctx, cookies, path);
        const location = resp.headers.get("location");
        if (resp.status < 300 || resp.status >= 400 || !location) {
          return isSetupPage(path) ? { kind: "page", path } : { kind: "done" };
        }
        const next = new URL(location, ctx.baseUrl);
        if (next.origin !== new URL(ctx.baseUrl).origin) return { kind: "external", location: next.href };
        if (!isSetupPage(next.pathname)) return { kind: "done" };
        path = next.pathname;
      }
      return { kind: "page", path };
    } catch (e) {
      ctx.log(`Reading the setup state, attempt ${attempt}: ${e}`);
      await ctx.sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error("PhotoStructure stopped answering during setup");
}

function isSetupPage(path: string): boolean {
  return path.startsWith("/welcome") || path.startsWith("/settings");
}

async function submitPage(ctx: HookContext, cookies: Map<string, string>, path: string) {
  const page = await request(ctx, cookies, path);
  const html = await page.text();
  let body: URLSearchParams;
  if (path.startsWith("/welcome/tools")) {
    body = new URLSearchParams({ consent: "no" });
  } else if (path.startsWith("/settings")) {
    body = formDefaults(html, "/settings");
    body.set("action", "");
  } else {
    body = formDefaults(html, path);
  }

  const action = formAction(html) ?? path;
  ctx.log(`Submitting ${path} to ${action}`);
  const resp = await request(ctx, cookies, action, body);
  if (resp.status >= 400) {
    ctx.fail(`PhotoStructure refused its setup page ${path}.`, [
      { label: "Endpoint", value: `POST ${ctx.baseUrl}${action} (${resp.status})` },
    ]);
  }
}

async function request(ctx: HookContext, cookies: Map<string, string>, path: string, body?: URLSearchParams) {
  const resp = await fetch(`${ctx.baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...cookieHeader(cookies),
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body?.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  for (const cookie of resp.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return resp;
}

function cookieHeader(cookies: Map<string, string>): Record<string, string> {
  if (cookies.size === 0) return {};
  return { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
}

function formAction(html: string): string | undefined {
  return html.match(/<form\b[^>]*\baction="([^"]+)"/i)?.[1];
}

/** The fields a browser would send for the page's first form, left exactly as PhotoStructure filled it. */
function formDefaults(html: string, path: string): URLSearchParams {
  const form = html.match(/<form\b[\s\S]*?<\/form>/i)?.[0];
  if (!form) throw new Error(`No form on PhotoStructure's ${path} page`);
  const params = new URLSearchParams();
  for (const [tag] of form.matchAll(/<input\b[^>]*>/gi)) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1];
    const name = attr("name");
    if (!name) continue;
    const type = (attr("type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button") continue;
    if ((type === "radio" || type === "checkbox") && !/\bchecked\b/i.test(tag)) continue;
    params.append(name, decodeEntities(attr("value") ?? (type === "checkbox" ? "on" : "")));
  }
  return params;
}

function decodeEntities(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * The install-photostructure-tools hook: the owner turned on "Install photo and video tools?" in
 * the install dialog, which carries PhotoStructure's own notice and acknowledgement. Gives the same
 * answer PhotoStructure's /welcome/tools form records, waits for its installer, and rescans Photos
 * so HEIC photos and videos skipped so far are imported.
 */
export async function installTools(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "appReady", message: "Starting PhotoStructure" },
    { id: "installed", message: "Installing photo and video tools" },
    { id: "rescanned", message: "Rescanning Photos" },
  ]);

  await ctx.waitForApp("/ping", { maxAttempts: 50, initialDelayMs: 10000, maxDelayMs: 15000 });
  await ctx.emitCheckpoint("appReady", "PhotoStructure is running");

  if (await toolsSupported(ctx)) {
    ctx.log("Photo and video tools are already installed.");
    await ctx.emitCheckpoint("installed", "Already installed");
  } else {
    const consent = await fetch(`${ctx.baseUrl}/welcome/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent: "yes", ack: "yes" }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    // The form redirects once it has recorded the answer; it re-renders itself when it can't install.
    if (consent.status !== 302 && consent.status !== 303) {
      ctx.fail("PhotoStructure could not start installing its photo and video tools.", [
        { label: "Endpoint", value: `POST ${ctx.baseUrl}/welcome/tools (${consent.status})` },
        { label: "Suggestion", value: "Open PhotoStructure's Manage photo and video tools page to see why" },
      ]);
    }

    const status = await waitForInstaller(ctx);
    if (status.phase !== "succeeded") {
      ctx.fail("PhotoStructure could not install its photo and video tools.", [
        { label: "Error", value: status.error ?? `installer ${status.phase}` },
        { label: "Last log", value: (status.log ?? []).slice(-3).join(" / ") || "none" },
        { label: "Suggestion", value: "The box needs internet access; retry from PhotoStructure's Manage photo and video tools page" },
      ]);
    }
    await ctx.emitCheckpoint("installed", "Photo and video tools installed");
  }

  const rescan = await fetch(`${ctx.baseUrl}/api/sync/resync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/photos" }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => e as Error);
  if (rescan instanceof Error || !rescan.ok) {
    ctx.log(`Rescan request failed (${rescan instanceof Error ? rescan.message : rescan.status}); the next scheduled sync will pick them up.`);
    await ctx.emitCheckpoint("rescanned", "Will import on the next sync");
  } else {
    await ctx.emitCheckpoint("rescanned", "Rescanning Photos for HEIC photos and videos");
  }
}

type InstallerStatus = { phase: string; error?: string; log?: string[] };

async function waitForInstaller(ctx: HookContext): Promise<InstallerStatus> {
  const deadline = Date.now() + TOOLS_INSTALL_LIMIT_MS;
  let last: InstallerStatus = { phase: "idle" };
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${ctx.baseUrl}/admin/install-tools/status`, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        last = (await resp.json()) as InstallerStatus;
        if (last.phase === "succeeded" || last.phase === "failed") return last;
        const label = (last as { statusLabel?: string }).statusLabel;
        if (label) ctx.log(`Installer: ${label}`);
      }
    } catch (e) {
      ctx.log(`Reading installer status: ${e}`);
    }
    await ctx.sleep(TOOLS_POLL_MS);
  }
  return { ...last, error: last.error ?? "timed out waiting for the installer" };
}

/**
 * Both of PhotoStructure's tool health checks report ok. They lag an install by minutes ("pending"),
 * so this only short-cuts a rerun; the installer's own "succeeded" is what confirms a fresh install.
 */
async function toolsSupported(ctx: HookContext): Promise<boolean> {
  {
    try {
      const resp = await fetch(`${ctx.baseUrl}/api/health/checks`, { signal: AbortSignal.timeout(20000) });
      if (resp.ok) {
        const levels = new Map<string, string>();
        collectLevels(await resp.json(), levels);
        if (levels.get("tools-heif") === "ok" && levels.get("tools-video") === "ok") return true;
        ctx.log(`Tool health: heif=${levels.get("tools-heif")} video=${levels.get("tools-video")}`);
      }
    } catch (e) {
      ctx.log(`Reading tool health: ${e}`);
    }
  }
  return false;
}

function collectLevels(value: unknown, levels: Map<string, string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectLevels(item, levels);
  } else if (value && typeof value === "object") {
    const check = value as { id?: unknown; level?: unknown };
    if (typeof check.id === "string" && typeof check.level === "string") levels.set(check.id, check.level);
    for (const child of Object.values(value)) collectLevels(child, levels);
  }
}
