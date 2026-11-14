// Sibling files are inlined into each bundle by the bundler.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

import type { ContextMount, HookContext } from "../_lib/hook_context";
import { maskToken, authHeaders, discoverOidc } from "./client";
import { BLUEPRINT_YAML } from "./blueprint";

const BLUEPRINT_FILENAME = "hexos-sso-blueprint.yaml";
const MANIFEST_FILENAME = "hexos-sso-manifest.json";
const BOOTSTRAP_TOKEN = "hexos-sso";

/**
 * Well-known path where the manifest is ALSO written, so consumer hooks can
 * discover it without knowing the authentik install location. Consumer hooks
 * hardcode this same constant (type-only sharing isn't possible at runtime).
 */
const SHARED_MANIFEST_PATH = "/mnt/.ix-apps/sso/manifest.json";

/** A mount is matched by its fixed container path, falling back to a host path suffix. */
function findMount(mounts: ContextMount[], containerPath: string, hostSuffix?: string): ContextMount | undefined {
  return (
    mounts.find((m) => m.containerPath === containerPath) ??
    (hostSuffix === undefined ? undefined : mounts.find((m) => m.hostPath.endsWith(hostSuffix)))
  );
}

export async function afterInstall(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "waitForApp", message: "Waiting for Authentik to start" },
    { id: "writeBlueprint", message: "Writing the SSO blueprint" },
    { id: "writeManifest", message: "Writing the SSO manifest for consumer apps" },
    { id: "verifyApi", message: "Verifying the blueprint via the API" },
    { id: "reportDetails", message: "Reporting connection details" },
  ]);

  if (!ctx.baseUrl) ctx.fail("HexOS couldn't find this Authentik server's address");

  // 1. Wait for Authentik to become healthy.
  // The server container can take a while on first boot (DB init, migrations).
  try {
    await ctx.waitForApp("/-/health/", {
      maxAttempts: 60,
      initialDelayMs: 5_000,
      maxDelayMs: 15_000,
    });
  } catch (error) {
    ctx.fail("Authentik didn't become healthy in time", [
      { label: "Endpoint", value: `${ctx.baseUrl}/-/health/` },
      { label: "Error", value: String(error) },
    ]);
  }
  await ctx.emitCheckpoint("waitForApp");

  // 2. Find the templates mount and write the blueprint.
  const templates = findMount(ctx.mounts, "/templates", "/templates");
  if (!templates) {
    ctx.fail("Couldn't find the templates directory", [
      { label: "Available mounts", value: ctx.mounts.map((m) => `${m.hostPath} → ${m.containerPath ?? "?"}`).join(", ") || "(none)" },
    ]);
  }

  const blueprintPath = templates.localPath + "/" + BLUEPRINT_FILENAME;
  try {
    writeFileSync(blueprintPath, BLUEPRINT_YAML, "utf-8");
  } catch (error) {
    ctx.fail("Couldn't write the SSO blueprint", [
      { label: "Path", value: blueprintPath },
      { label: "Error", value: String(error) },
    ]);
  }
  ctx.log(`Blueprint written to ${blueprintPath}`);
  await ctx.emitCheckpoint("writeBlueprint");

  // 3. Write the SSO manifest. Consumer install hooks read this file to learn the
  // issuer and OIDC endpoint URLs. Client creation happens on-demand via
  // authentik API calls from spoke hooks at connection time.
  const data = findMount(ctx.mounts, "/data", "/data");
  if (!data) {
    ctx.fail("Couldn't find the data directory", [
      { label: "Available mounts", value: ctx.mounts.map((m) => `${m.hostPath} → ${m.containerPath ?? "?"}`).join(", ") || "(none)" },
    ]);
  }

  // ctx.baseUrl is the TrueNAS-assigned URL (includes port), used identically across all hooks in the catalog.
  const base = ctx.baseUrl.replace(/\/[^/]*$/, "");
  const manifest = {
    version: 1,
    generatedBy: "hexos-authentik",
    issuer: base,
    // Derive from the shared discoverOidc() so the manifest and every spoke
    // share one source of truth for the OIDC endpoint paths.
    oidc: discoverOidc(base).oidc,
    ldap: {
      endpoint: `ldap://${base.replace(/^https?:\/\//, "").split(":")[0]}:389`,
      baseDn: "dc=ldap,dc=goauthentik,dc=io",
    },
    token: BOOTSTRAP_TOKEN,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";

  // The manifest carries the bootstrap bearer token — restrict it to the owner
  // (0600) wherever the filesystem allows it. Best effort: some TrueNAS shares
  // don't honour chmod, in which case the write still succeeds.
  const writeManifestFile = (path: string) => {
    writeFileSync(path, manifestJson, { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort — non-blocking */
    }
  };

  const manifestPath = data.localPath + "/" + MANIFEST_FILENAME;
  try {
    mkdirSync(data.localPath, { recursive: true });
    writeManifestFile(manifestPath);
  } catch (error) {
    ctx.fail("Couldn't write the SSO manifest", [
      { label: "Path", value: manifestPath },
      { label: "Error", value: String(error) },
    ]);
  }
  ctx.log(`SSO manifest written to ${manifestPath}`);

  // Also write to a well-known shared path so consumer hooks can discover it
  // without knowing the authentik install location. Non-fatal if the directory
  // isn't writable (the per-app copy is still available).
  try {
    mkdirSync(dirname(SHARED_MANIFEST_PATH), { recursive: true });
    writeManifestFile(SHARED_MANIFEST_PATH);
    ctx.log(`SSO manifest also written to ${SHARED_MANIFEST_PATH}`);
  } catch (error) {
    ctx.log(`NOTE: couldn't write shared manifest to ${SHARED_MANIFEST_PATH}: ${error}`);
  }
  await ctx.emitCheckpoint("writeManifest");

  // 4. Verify the blueprint was reconciled by polling for the LDAP outpost. Instead of
  // a blind sleep, we wait until the outpost appears in the API (up to a timeout).
  const apiBase = `${ctx.baseUrl}/api/v3`;
  const apiHeaders = authHeaders(BOOTSTRAP_TOKEN);

  ctx.log("Polling for LDAP outpost creation (blueprint reconciliation)");
  const reconciliationTimeout = 60_000; // max total wait
  const pollInterval = 2_000;
  const deadline = Date.now() + reconciliationTimeout;
  let outpostFound = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${apiBase}/outposts/?slug=truenas`,
        { headers: apiHeaders, signal: AbortSignal.timeout(5_000) },
      );
      if (res.ok) {
        const body = (await res.json()) as { results: unknown[] };
        if (body.results.length > 0) {
          outpostFound = true;
          ctx.log("LDAP outpost verified in authentik");
          break;
        }
      }
    } catch {
      // API not ready yet — keep polling
    }
    await ctx.sleep(pollInterval);
  }
  if (!outpostFound) {
    ctx.log("WARNING: LDAP outpost not found via API after polling — it may still be provisioning");
  }

  try {
    // OpenAPI drift check: warn if endpoint layout changed under us.
    const openapi: { paths?: Record<string, unknown> } = await (
      await fetch(`${apiBase}/openapi.json`, { headers: apiHeaders, signal: AbortSignal.timeout(10_000) })
    ).json();
    const expectedPaths = ["/providers/oauth2/", "/outposts/", "/core/application/"];
    const missing = expectedPaths.filter((p) => !(p in (openapi.paths ?? {})));
    if (missing.length > 0) {
      ctx.log(`WARNING: expected API paths missing from OpenAPI (possible version drift): ${missing.join(", ")}`);
    }
  } catch (error) {
    ctx.log(`WARNING: API verification skipped: ${error}`);
  }
  await ctx.emitCheckpoint("verifyApi");

  // 5. Report the connection details the user needs for TrueNAS LDAP config.
  ctx.log(`Authentik web:      ${ctx.baseUrl}`);
  ctx.log(`LDAP endpoint:      ldap://${base.replace(/^https?:\/\//, "").split(":")[0]}:389`);
  ctx.log(`Base DN:            dc=ldap,dc=goauthentik,dc=io`);
  ctx.log(`Service account DN: cn=ldapservice,ou=users,dc=ldap,dc=goauthentik,dc=io`);
  ctx.log(`Spoke manifest:     ${manifestPath}`);
  ctx.log(`OAuth2 clients will be created on-demand when spokes connect`);
  await ctx.emitCheckpoint("reportDetails");
}
export async function onBeforeUninstall(ctx: HookContext) {
  const base = ctx.baseUrl.replace(/\/[^/]*$/, "");
  ctx.log("=== SSO Uninstall Report ===");
  ctx.log(`${base}/templates/hexos-sso-blueprint.yaml`);
  ctx.log("Resources created by SSO (owned by authentik — do not delete):");
  ctx.log("  - LDAP Provider:    truenas-ldap");
  ctx.log("  - LDAP Outpost:     truenas (port 389)");
  ctx.log("  - Service account:  ldapservice");
  ctx.log("  - LDAP Group user:  hexos-ldap-group");
  ctx.log("  - Docker service:   truenas-ldap-docker");
  ctx.log("Spoke client registrations (owned by authentik — leave for spokes to manage):");
  ctx.log("  - Provider:   truenas-jellyfin (jellyfin)");
  ctx.log("  - Application: HexOS SSO — truenas-jellyfin (jellyfin-app)");
  ctx.log("Note: Remove 'jellyfin' and 'jellyfin-app' manually if Jellyfin is being decommissioned.");
}
