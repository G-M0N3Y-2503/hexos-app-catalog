// Shared HTTP client for authentik API operations.
// Eliminates duplicate fetch/parsing/error-handling across spoke hooks.
//
// Each hook script compiles standalone, so the client is inlined into each bundle
// (the code is small — ~40 lines). Type imports are handled via types.ts.

import type { SsoManifest, AuthentikProvider, AuthentikApplication, SpokeSsoConfig, SpokeSsoResult, SpokeContext, RunSsoFlowConfig, AuthentikOidcEndpoints } from "./types";
import type { ContextMount } from "../_lib/hook_context";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Mask a token for safe logging — replaces with a minimal, safe placeholder.
 * Uses Unicode ⚠️ prefix to stand out in logs without leaking secrets.
 */
export function maskToken(token: string, appId?: string): string {
  if (!token) return "⚠️<empty>";
  return appId ? `⚠️${appId}` : "⚠️<token>";
}

/**
 * Build auth headers for an authentik API request.
 */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Generic authentik v3 API request.
 *
 * `apiBase` is the full admin API base (issuer + `/api/v3`) — the same base the
 * hub uses, so spokes and hub can't drift. A 404 resolves to `undefined` (the
 * resource simply doesn't exist yet); any other non-2xx throws with the body so
 * the failure is diagnosable.
 */
export async function authentikRequest<T>(
  apiBase: string,
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  const isGet = method === "GET";
  const resp = await fetch(`${apiBase}${path}`, {
    method,
    headers: authHeaders(token),
    body: isGet || body === undefined ? undefined : JSON.stringify(body),
  });
  if (resp.status === 404) return undefined;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText} on ${method} ${path}: ${text}`);
  }
  if (resp.status === 204) return undefined;
  return (await resp.json()) as T;
}

/**
 * Get a provider by slug from authentik API (v3).
 */
export async function getProvider(
  apiBase: string,
  token: string,
  slug: string,
): Promise<AuthentikProvider | undefined> {
  return authentikRequest<AuthentikProvider>(apiBase, token, "GET", `/providers/oauth2/${encodeURIComponent(slug)}/`);
}

/**
 * Get an application by slug from authentik API (v3).
 */
export async function getApplication(
  apiBase: string,
  token: string,
  slug: string,
): Promise<AuthentikApplication | undefined> {
  return authentikRequest<AuthentikApplication>(apiBase, token, "GET", `/core/application/${encodeURIComponent(slug)}/`);
}

/** Manifest filename written into authentik's data volume by the hub. */
export const MANIFEST_FILENAME = "hexos-sso-manifest.json";
/** Fallback location the hub also writes to, on TrueNAS/HexOS shared storage. */
export const SHARED_MANIFEST_PATH = "/mnt/.ix-apps/sso/manifest.json";

/**
 * Resolve the manifest path from the platform.
 * Priority:
 *   1. Platform discovery: authentik's data mount → manifest file
 *   2. Hardcoded shared path: /mnt/.ix-apps/sso/manifest.json
 */
export async function ssoManifestPath(ctx: { getInstalledAppMounts?: (appId: string) => Promise<ContextMount[]> | ContextMount[] }): Promise<string> {
  if (ctx.getInstalledAppMounts) {
    try {
      const dataMount = (await ctx.getInstalledAppMounts("authentik")).find(
        (m) => m.containerPath?.includes("data") || m.containerPath === "/data",
      );
      if (dataMount?.localPath) return join(dataMount.localPath, MANIFEST_FILENAME);
    } catch {
      /* fall through to the shared path */
    }
  }
  return SHARED_MANIFEST_PATH;
}

/**
 * Parse and validate a manifest.json string.
 * Validates version === 1, throws on mismatch.
 */
export function parseManifest(raw: string): SsoManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse SSO manifest: ${msg}`);
  }
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("SSO manifest is not a valid JSON object");
  }
  const m = manifest as Record<string, unknown>;
  if (typeof m.version !== "number") {
    throw new Error("SSO manifest missing numeric 'version' field");
  }
  if (m.version !== 1) {
    throw new Error(
      `Manifest version ${m.version} is not supported. ` +
      "You may need to update HexOS or contact support.",
    );
  }
  return m as unknown as SsoManifest;
}

/**
 * Read the shared SSO manifest from the platform.
 * Priority:
 *   1. Platform discovery: ctx.getInstalledAppMounts("authentik") → find data mount → manifest file
 *   2. Hardcoded shared path: /mnt/.ix-apps/sso/manifest.json
 *   3. Throw if neither is available
 */
export async function readManifest(ctx: {
  getInstalledAppMounts?: (appId: string) => Promise<ContextMount[]> | ContextMount[];
}): Promise<SsoManifest> {
  const candidates: string[] = [];
  const discovered = await ssoManifestPath(ctx);
  if (discovered) candidates.push(discovered);
  if (!candidates.includes(SHARED_MANIFEST_PATH)) candidates.push(SHARED_MANIFEST_PATH);

  const seen = new Set<string>();
  const errors: string[] = [];
  for (const mpath of candidates) {
    if (seen.has(mpath)) continue;
    seen.add(mpath);
    if (!existsSync(mpath)) continue;
    try {
      return parseManifest(readFileSync(mpath, "utf-8"));
    } catch (e: unknown) {
      errors.push(`${mpath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(
    `No readable SSO manifest found at: ${[...seen].join(", ")}. ` +
    "Is authentik installed and has the hub hook run? " +
    (errors.length ? `Parse errors — ${errors.join("; ")}` : ""),
  );
}

/**
 * Create (or reuse) an on-demand SSO spoke in authentik.
 *
 * Flow — always idempotent, so re-running a hook never rotates credentials:
 * 1. Reuse the provider if it already exists; otherwise create one (authentik
 *    auto-generates client_id/client_secret on creation).
 * 2. Reuse the paired application if it exists; otherwise create it.
 * 3. Return both resources.
 */
export async function createSsoApp(
  apiBase: string,
  token: string,
  config: SpokeSsoConfig,
): Promise<SpokeSsoResult> {
  const { providerSlug, providerDisplay } = config;
  const appSlug = `${providerSlug}-app`;

  // Reuse an existing provider if present (idempotent). The client_id/secret are
  // generated by authentik on creation, so recreating would rotate credentials
  // and break already-wired clients.
  let provider = await getProvider(apiBase, token, providerSlug);
  if (!provider) {
    provider = await authentikRequest<AuthentikProvider>(apiBase, token, "POST", "/providers/oauth2/", {
      name: providerDisplay,
      slug: providerSlug,
      client_type: "confidential",
      client_authentication_method: "secret-basic",
      pkce_required: false,
      skip_consent: true,
      authorization_flow: "default-provider-authorization-explicit-consent",
      token_flow: "default-token",
    });
    if (!provider) throw new Error("authentik did not return the created provider.");
  }

  // Reuse the paired application if present.
  let application = await getApplication(apiBase, token, appSlug);
  if (!application) {
    application = await authentikRequest<AuthentikApplication>(apiBase, token, "POST", "/core/application/", {
      name: `HexOS SSO — ${providerDisplay}`,
      slug: appSlug,
      provider: provider.slug,
    });
    if (!application) throw new Error("authentik did not return the created application.");
  }

  return { provider, application };
}

/**
 * Derive the canonical authentik OIDC endpoints + discovery URL from an issuer.
 *
 * All spokes call this so no app hook ever hardcodes authentik's internal paths.
 * The discovery URL is what most OIDC clients can consume directly.
 */
export function discoverOidc(issuer: string): { discoveryUrl: string; oidc: AuthentikOidcEndpoints } {
  const base = issuer.replace(/\/+$/, "");
  return {
    discoveryUrl: `${base}/.well-known/openid-configuration/`,
    oidc: {
      authorizationEndpoint: `${base}/application/o/authorize/`,
      tokenEndpoint: `${base}/application/o/token/`,
      userinfoEndpoint: `${base}/application/o/user/`,
      jwksEndpoint: `${base}/application/o/certs/`,
      endSessionEndpoint: `${base}/application/o/logout/`,
    },
  };
}

/**
 * Log an SSO configuration completion summary.
 * Each hook calls this once after runSsoFlow returns.
 */
export function logSsoSummary(
  ctx: {
    log: (msg: string) => void;
    appTitle: string;
  },
  spoke: SpokeContext,
): void {
  ctx.log("=== SSO Configuration Complete ===");
  ctx.log(`Spoke:         ${spoke.provider.name}`);
  ctx.log(`Issuer:        ${spoke.issuer}`);
  ctx.log(`Discovery:     ${spoke.discoveryUrl}`);
  ctx.log(`${ctx.appTitle}:    ${spoke.appUrl}`);
  ctx.log(`Client ID:     ${spoke.provider.client_id}`);
}

/**
 * Shared mount resolver — tries multiple predicates to find the right mount.
 *
 * Each spoke defines its own predicates; this function tries them in order.
 * If no predicates are supplied, defaults to matching containerPath "/config".
 */
export function configMount(
  mounts: ContextMount[],
  predicates: Array<(m: ContextMount) => boolean> = [
    (m) => m.containerPath === "/config",
  ],
): ContextMount | undefined {
  for (const pred of predicates) {
    const found = mounts.find(pred);
    if (found) return found;
  }
  return undefined;
}

/**
 * Validate that the target app is installed and discoverable.
 *
 * Pass the hook's ctx directly — it already carries the platform methods.
 * Returns `{ baseUrl, mounts }` or calls `ctx.fail()` with diagnostic
 * information if the app URL or mounts cannot be found.
 */
export async function requireAppInfo(
  ctx: {
    getInstalledAppUrl: (appId: string) => Promise<string | null>;
    getInstalledAppMounts: (appId: string) => Promise<ContextMount[]>;
    fail: (msg: string, details?: Array<{ label: string; value: string }>) => never;
  },
  appId: string,
  appTitle: string,
): Promise<{ baseUrl: string; mounts: ContextMount[] }> {
  const baseUrl = await ctx.getInstalledAppUrl(appId);
  if (!baseUrl) {
    ctx.fail(`No URL found for ${appTitle}. Is ${appTitle} installed?`, [
      { label: "Installed apps", value: "(unable to enumerate)" },
    ]);
  }

  const mounts = await ctx.getInstalledAppMounts(appId);
  if (mounts.length === 0) {
    ctx.fail(`No mounts found for ${appId}. Is ${appTitle} installed?`, [
      { label: "Mounts inspected", value: mirrors(mounts, 5) + (mounts.length > 5 ? "…" : "") },
    ]);
  }

  return { baseUrl, mounts };
}

/**
 * Call a target app's HTTP API with error handling.
 *
 * Eliminates the per-spoke fetch wrappers (callJellyfin, callImmichApi, …).
 * Headers are additive on top of a default JSON content type; pass auth
 * headers per-app.
 */
export async function callAppApi<T = Record<string, unknown>>(opts: {
  baseUrl: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Used in error messages so failure logs name the app (e.g. "Jellyfin"). */
  errorLabel?: string;
}): Promise<T> {
  const url =
    opts.baseUrl.replace(/\/+$/, "") +
    (opts.path.startsWith("/") ? opts.path : `/${opts.path}`);
  const label = opts.errorLabel ?? "App";
  const res = await fetch(url, {
    method: opts.method,
    headers: { "Content-Type": "application/json", ...opts.headers },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    ...(!opts.body ? {} : { body: JSON.stringify(opts.body) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${label} ${res.status}: ${text.slice(0, 500)}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

// ── private helpers ─────────────────────────────────────────────────

/** Format mount paths for diagnostic output. */
function mirrors(mounts: ContextMount[], limit: number): string {
  return mounts.slice(0, limit).map((m) => m.hostPath).join(", ");
}

/**
 * Lifecycle runner for SSO spoke hooks.
 *
 * Abstracts the shared flow — register checkpoints, read manifest, create
 * the spoke, invoke app-specific configure & verify callbacks — so individual
 * hooks focus only on the things that differ.
 *
 * Checkpoint order:
 *   1. `readManifest`   — manifest read & version validated
 *   2. `createSpoke`    — provider + application created in authentik
 *  ~N. `configureX`     — app-specific configure callback
 *  ~N. `verifyX`        — app-specific verify callback
 *
 * Returns the constructed SpokeContext so callers can log summary info.
 */
export async function runSsoFlow(
  ctx: {
    registerCheckpoints: (cpts: { id: string; message: string }[]) => Promise<void>;
    log: (msg: string) => void;
    emitCheckpoint: (id: string) => Promise<void>;
    getInstalledAppMounts: (appId: string) => Promise<ContextMount[]> | ContextMount[];
  },
  config: RunSsoFlowConfig,
  appUrl: string,
  redirectUri: string,
  configure: (spoke: SpokeContext) => Promise<boolean>,
  verify: (spoke: SpokeContext) => Promise<void>,
): Promise<SpokeContext> {
  // 1. Register checkpoints (always: readManifest, createSpoke + 2 app-specific).
  ctx.registerCheckpoints([
    { id: "readManifest", message: "Reading SSO manifest (authentik)" },
    { id: "createSpoke", message: `Creating ${config.providerDisplay} SSO spoke in authentik` },
    { id: config.configureCheckpoint, message: `Configuring ${config.providerDisplay}` },
    { id: config.verifyCheckpoint, message: `Verifying ${config.providerDisplay} sign-in` },
  ]);

  // 2. Read & validate manifest.
  const manifest = await readManifest(ctx);
  ctx.log(`SSO manifest read: version=${manifest.version}, issuer=${manifest.issuer}`);
  await ctx.emitCheckpoint("readManifest");

  // 3. Derive the issuer, admin API base, and canonical OIDC endpoints.
  const issuer = manifest.issuer.replace(/\/+$/, "");
  const apiBase = `${issuer}/api/v3`;
  const token = manifest.token;
  const { discoveryUrl, oidc } = discoverOidc(issuer);

  // 4. Create (or reuse) the spoke in authentik.
  const { provider, application } = await createSsoApp(apiBase, token, {
    providerSlug: config.providerSlug,
    providerDisplay: config.providerDisplay,
  });
  ctx.log(
    `SSO spoke ready: provider="${config.providerDisplay}", application="${config.providerSlug}-app"`,
  );
  await ctx.emitCheckpoint("createSpoke");

  // 5. App-specific configure callback.
  const spoke: SpokeContext = { provider, application, issuer, apiBase, discoveryUrl, oidc, appUrl, redirectUri };
  const didWork = await configure(spoke);
  if (!didWork) {
    ctx.log(`${config.providerDisplay}: already configured, skipping`);
  }
  await ctx.emitCheckpoint(config.configureCheckpoint);

  // 6. App-specific verify callback.
  await verify(spoke);
  await ctx.emitCheckpoint(config.verifyCheckpoint);

  return spoke;
}

/** Options for a one-shot SSO spoke hook (see `defineSsoSpoke`). */
export interface SsoSpokeOptions {
  /**
   * The HexOS app id (e.g. "jellyfin"). Provider slug, display name,
   * and checkpoint ids are all derived from this — no manual boilerplate.
   */
  appId: string;
  /** Human-facing name used in logs, checkpoint messages, and the summary (e.g. "Jellyfin"). */
  appTitle: string;
  /**
   * Redirect URI path appended to the app's base URL (e.g. "/api/openid/callback").
   * Use `redirectUri` instead for apps that use template-based URIs.
   */
  redirectUriPath?: string;
  /**
   * Full redirect URI override for apps that use template-based URIs
   * (e.g. Jellyfin's "http://{{ jellyfinHost }}/oauth/oidc").
   * When omitted, computed as `appUrl + redirectUriPath`.
   */
  redirectUri?: string;
  /**
   * The app-specific configure step. Receives the fully-resolved SpokeContext.
   * Returns `true` if configuration work was performed, `false` if already configured (no-op).
   */
  configure: (spoke: SpokeContext) => Promise<boolean>;
  /** Optional app-specific verify step. No-op by default. */
  verify?: (spoke: SpokeContext) => Promise<void>;
  /**
   * Pass a URL already resolved by the spoke (via `requireAppInfo`) to skip
   * re-resolving it here. Omit and the helper resolves it for you.
   */
  appUrl?: string;
}

/**
 * One-call SSO spoke helper — the whole hub-and-spoke lifecycle in a single call.
 *
 * Wraps the shared steps a spoke would otherwise stitch together:
 *   1. validate the target app is installed and resolve its URL,
 *   2. derive provider slug, display name, checkpoint ids, and redirect URI from `appId`,
 *   3. run `runSsoFlow` (manifest → create/reuse spoke → configure → verify),
 *   4. log the completion summary.
 *
 * A new app's SSO hook is just `appId`, `appTitle`, `redirectUriPath`,
 * and the app-specific `configure` callback — no shared plumbing.
 *
 * Returns the resolved SpokeContext so a caller can log app-specific extras.
 */
export async function defineSsoSpoke(
  ctx: {
    registerCheckpoints: (cpts: { id: string; message: string }[]) => Promise<void>;
    log: (msg: string) => void;
    emitCheckpoint: (id: string) => Promise<void>;
    getInstalledAppUrl: (appId: string) => Promise<string | null>;
    getInstalledAppMounts: (appId: string) => Promise<ContextMount[]>;
    fail: (msg: string, details?: Array<{ label: string; value: string }>) => never;
  },
  opts: SsoSpokeOptions,
): Promise<SpokeContext> {
  // 1. Validate install & resolve the target app's URL (skip if the spoke did).
  const baseUrl =
    opts.appUrl ?? (await requireAppInfo(ctx, opts.appId, opts.appTitle)).baseUrl;

  // 2. Derive per-app identifiers from appId.
  const providerSlug = opts.appId;
  const providerDisplay = `truenas-${opts.appId}`;
  const configureCheckpoint = `configure-${opts.appId}-sso`;
  const verifyCheckpoint = `verify-${opts.appId}-sso`;

  // 3. Compute the redirect URI.
  const redirectUri =
    opts.redirectUri ?? `${baseUrl.replace(/\/+$/, "")}${opts.redirectUriPath ?? ""}`;

  // 4. Shared SSO lifecycle.
  const spoke = await runSsoFlow(
    ctx,
    { providerSlug, providerDisplay, configureCheckpoint, verifyCheckpoint },
    baseUrl,
    redirectUri,
    opts.configure,
    opts.verify ?? (async () => { /* no verify step declared */ }),
  );

  // 5. Completion summary.
  logSsoSummary({ log: ctx.log, appTitle: opts.appTitle }, spoke);
  return spoke;
}
