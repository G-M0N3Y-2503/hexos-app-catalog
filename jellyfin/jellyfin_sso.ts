// Sibling files are type imports only: each script compiles standalone.
import { readFileSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";
import type { SpokeContext } from "../authentik/types";
import {
  callAppApi,
  configMount as _configMount,
  requireAppInfo,
  defineSsoSpoke,
} from "../authentik/client";

/**
 * Configures this Jellyfin server to sign in via Authentik (enable-sso).
 *
 * Flow:
 * 1. Read the SSO manifest via platform-discovered mounts (primary) or
 *    shared path fallback to discover authentik's API URL and bootstrap token.
 * 2. Call authentik's API to create an on-demand OAuth2 provider and application.
 *    Authentik generates unique client_id/client_secret.
 * 3. Create a dedicated Jellyfin user from the OIDC claims (if not already exists).
 * 4. Write Jellyfin's OpenIdConnect settings via its own API.
 */

/** Build Jellyfin's OIDC config. Exported for unit testing in _lib/. */
export function buildOidcConfig(spoke: SpokeContext) {
  return {
    displayName: "Authentik",
    enable: true,
    authorizationEndpoint: spoke.oidc.authorizationEndpoint,
    tokenEndpoint: spoke.oidc.tokenEndpoint,
    userInfoEndpoint: spoke.oidc.userinfoEndpoint,
    clientId: spoke.provider.client_id,
    clientSecret: spoke.provider.client_secret,
    redirectUri: spoke.redirectUri,
    callbackUri: spoke.redirectUri,
    logoutUri: `${spoke.appUrl}/Users/Login/Logout?returnTo=/`,
    metadataAddress: spoke.discoveryUrl,
    getClaimsFromUserInfoEndpoint: true,
    fullNameClaimType: "http://schemas.xmlsoap.org/ws/2005/05/authentication/ClaimTypes/Name",
    claimsMappingClaimType: "http://schemas.xmlsoap.org/ws/2005/05/authentication/ClaimTypes/EmailAddress",
    defaultAuthNamespace: "http://schemas.xmlsoap.org/ws/2005/05/authentication",
    scope: "openid email name",
    responseMode: "form_post",
    response_type: "code",
    grant_type: "authorization_code",
  };
}

/** Resolve Jellyfin's config mount — prefer /config, fall back to hostPath suffix. */
const configMount = (mounts: ContextMount[]): ContextMount | undefined =>
  _configMount(mounts, [
    (m) => m.containerPath === "/config",
    (m) => m.hostPath.endsWith("/jellyfin/config"),
  ]);

export async function afterInstall(ctx: HookContext) {
  const { baseUrl, mounts } = await requireAppInfo(ctx, "jellyfin", "Jellyfin");
  const configDir = configMount(mounts)?.localPath;
  if (!configDir) {
    ctx.fail("HexOS couldn't find Jellyfin's config mount. Is Jellyfin installed?", [
      { label: "Mounts inspected", value: mounts.length === 0 ? "(none — is the app installed?)" : mounts.map((m) => m.hostPath).join(", ") },
    ]);
  }

  // App-specific: read API key from Jellyfin config.xml
  let apiKey = "";
  try {
    const xml = readFileSync(configDir + "/config.xml", "utf-8");
    const match = xml.match(/<Key>([^<]+)<\/Key>/);
    if (!match) ctx.fail("Could not parse Jellyfin API key from config.xml");
    apiKey = match[1];
  } catch (err) {
    ctx.fail(`Could not read Jellyfin config.xml: ${err}`);
  }

  const configureCallback = async (spoke: SpokeContext): Promise<boolean> => {
    const oidcConfig = buildOidcConfig(spoke);

    // Idempotency pre-check — GET the existing provider list with the same
    // X-Api-Key header and match on the client_id we'd POST. The hub's
    // createSsoApp reuses the same authentik provider across re-runs, so the
    // client_id is stable; a match means Jellyfin already has this exact
    // provider wired and the POST would be a duplicate. The pre-check is
    // read-only and best-effort: any non-2xx (404 on an unknown endpoint,
    // 5xx, timeout) must never fail the write, so it swallows to "not found"
    // and configuration proceeds to the POST exactly as before.
    const existing = (
      await callAppApi<Array<{ clientId: string }>>({
        baseUrl: spoke.appUrl,
        method: "GET",
        path: "/System/IdentityProviders",
        headers: { "X-Api-Key": apiKey },
        errorLabel: "Jellyfin",
      }).catch((): [] => [])
    ) ?? [];
    if (existing.some((p) => p?.clientId === oidcConfig.clientId)) {
      return false; // Already wired — no work performed.
    }

    await callAppApi({
      baseUrl: spoke.appUrl,
      method: "POST",
      path: "/System/IdentityProviders/openIdConnect",
      headers: { "X-Api-Key": apiKey },
      body: oidcConfig,
      errorLabel: "Jellyfin",
    });
    ctx.log("Jellyfin OIDC settings saved");
    return true;
  };

  const verifyCallback = async (spoke: SpokeContext) => {
    try {
      const appUrl = spoke.appUrl.replace(/\/+$/, "");
      const resp = await fetch(`${appUrl}/oauth/oidc?redirect_uri=${encodeURIComponent(spoke.redirectUri)}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status === 302 || resp.status === 303) {
        ctx.log(`OIDC redirect verified — user can log in via Authentik`);
      } else {
        ctx.log(`OIDC endpoint returned ${resp.status} (may not redirect yet — config may need Jellyfin restart)`);
      }
    } catch (err) {
      ctx.log(`OIDC verification failed (Jellyfin may not be fully set up): ${err}`);
    }
  };

  // One-call SSO lifecycle (manifest → create/reuse spoke → configure → verify → summary)
  await defineSsoSpoke(ctx, {
    appId: "jellyfin",
    appTitle: "Jellyfin",
    redirectUriPath: "/oauth/oidc",
    appUrl: baseUrl,
    configure: configureCallback,
    verify: verifyCallback,
  });
}
