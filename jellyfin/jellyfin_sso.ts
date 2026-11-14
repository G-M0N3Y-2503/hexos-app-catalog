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
export function buildOidcConfig(params: SpokeContext) {
  return {
    displayName: "Authentik",
    enable: true,
    authorizationEndpoint: params.oidc.authorizationEndpoint,
    tokenEndpoint: params.oidc.tokenEndpoint,
    userInfoEndpoint: params.oidc.userinfoEndpoint,
    clientId: params.provider.client_id,
    clientSecret: params.provider.client_secret,
    redirectUri: params.redirectUri,
    callbackUri: params.redirectUri,
    logoutUri: `${params.appUrl}/Users/Login/Logout?returnTo=/`,
    metadataAddress: params.discoveryUrl,
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

/** Read Jellyfin's admin API key from config.xml. */
function getAdminApiKeyFromConfig(configDir: string, ctx: HookContext): string {
  try {
    const xml = readFileSync(configDir + "/config.xml", "utf-8");
    const match = xml.match(/<Key>([^<]+)<\/Key>/);
    if (!match) ctx.fail("Could not parse Jellyfin API key from config.xml");
    return match[1];
  } catch (err) {
    ctx.fail(`Could not read Jellyfin config.xml: ${err}`);
  }
}

export async function afterInstall(ctx: HookContext) {
  const { baseUrl, mounts } = await requireAppInfo(ctx, "jellyfin", "Jellyfin");
  const configDir = configMount(mounts)?.localPath;
  if (!configDir) {
    ctx.fail("HexOS couldn't find Jellyfin's config mount. Is Jellyfin installed?", [
      { label: "Mounts inspected", value: mounts.length === 0 ? "(none — is the app installed?)" : mounts.map((m) => m.hostPath).join(", ") },
    ]);
  }

  const apiKey = getAdminApiKeyFromConfig(configDir, ctx);

  const isConfigured = async (spoke: SpokeContext): Promise<boolean> => {
    const existing = await callAppApi<Array<{ clientId: string }>>({
      baseUrl: spoke.appUrl,
      method: "GET",
      path: "/System/IdentityProviders",
      headers: { "X-Api-Key": apiKey },
      errorLabel: "Jellyfin",
    }).catch((): [] => []);
    if (!Array.isArray(existing)) return false;
    return existing.some((p) => p?.clientId === spoke.provider.client_id);
  };

  const configure = async (spoke: SpokeContext): Promise<boolean> => {
    const oidcConfig = buildOidcConfig(spoke);

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

  const verify = {
    custom: async (spoke: SpokeContext, log: { log: (msg: string) => void }) => {
      try {
        const url = spoke.appUrl.replace(/\/+$/, "");
        const resp = await fetch(
          `${url}/oauth/oidc?redirect_uri=${encodeURIComponent(spoke.redirectUri)}`,
          { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) },
        );
        if (resp.status === 302 || resp.status === 303) {
          log.log(`OIDC redirect verified — user can log in via Authentik`);
        } else {
          log.log(`OIDC endpoint returned ${resp.status} (may not redirect yet — config may need Jellyfin restart)`);
        }
      } catch (err) {
        log.log(`OIDC verification failed (Jellyfin may not be fully set up): ${err}`);
      }
    },
  };

  await defineSsoSpoke(ctx, {
    appId: "jellyfin",
    appTitle: "Jellyfin",
    redirectUriPath: "/oauth/oidc",
    isConfigured,
    configure,
    verify,
  });
}
