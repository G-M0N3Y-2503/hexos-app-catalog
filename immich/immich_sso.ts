// Sibling files are type imports only: each script compiles standalone.
import type { HookContext } from "../_lib/hook_context";
import type { SpokeContext } from "../authentik/types";
import {
  callAppApi,
  requireAppInfo,
  defineSsoSpoke,
} from "../authentik/client";

/**
 * Configures Immich to authenticate via Authentik OIDC (enable-sso).
 *
 * Flow:
 * 1. Read the SSO manifest via platform-discovered mounts to discover authentik's API URL and bootstrap token.
 * 2. Create an on-demand OAuth2 provider and application in authentik.
 * 3. Register the OIDC provider in Immich via its Admin API.
 * 4. Verify the OIDC endpoint responds.
 */

/** OIDC authorization callback path in Immich web. */
const CALLBACK_PATH = "/web/auth/openid-form";

/**
 * Ask the user to paste Immich's Admin API Key from Settings (copied from Immich UI).
 *
 * The Admin API Key is auto-generated on first run and shown once in Immich Settings.
 * Immich does not store it in a file the hook can read.
 */
async function getAdminApiKey(ctx: HookContext): Promise<string> {
  const answers = await ctx.askForInputs([
    {
      type: "question",
      id: "admin_api_key",
      question: {
        question: "Immich Admin API Key",
        type: "password",
        key: "adminApiKey",
        required: true,
        description: "Found in Immich Settings → Admin API Key → Copy. If you did not copy it on first run, regenerate one.",
        placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      },
    },
  ], {
    title: "Immich Admin API Key",
    description: "Enter the Admin API Key from Immich Settings so this hook can register the OIDC provider.",
  });
  const apiKey = answers.adminApiKey as string;
  if (!apiKey) ctx.fail("Admin API Key was not provided");
  return apiKey;
}

/**
 * Build the OIDC provider config for Immich. Exported for unit testing in _lib/.
 */
export function buildOidcConfig(spoke: SpokeContext): Record<string, unknown> {
  const logoUrl = `${spoke.issuer}/static/favicon-96x96.png`;

  return {
    label: "HexOS",
    issuer: spoke.issuer,
    client_id: spoke.provider.client_id,
    client_secret: spoke.provider.client_secret,

    // Canonical OIDC endpoints from the shared SpokeContext (single source of
    // truth — see authentik/client.ts discoverOidc()).
    authorization_endpoint: spoke.oidc.authorizationEndpoint,
    token_endpoint: spoke.oidc.tokenEndpoint,
    userinfo_endpoint: spoke.oidc.userinfoEndpoint,
    end_session_endpoint: spoke.oidc.endSessionEndpoint,

    // Authentication settings.
    scope: "openid email profile",
    ui_locales: true,
    use_pkce: true,
    create_user: true,

    // Immich-specific fields.
    ui_message: "Sign in with HexOS",
    use_immich_token: false,
    logout_redirect: encodeURIComponent(`${spoke.oidc.endSessionEndpoint}?client_id=${spoke.provider.client_id}`),
    logo_url: logoUrl,
  };
}

export async function afterInstall(ctx: HookContext) {
  const { baseUrl } = await requireAppInfo(ctx, "immich", "Immich");
  const apiKey = await getAdminApiKey(ctx);

  const configureCallback = async (spoke: SpokeContext): Promise<boolean> => {
    // Check if the provider is already registered.
    const existing = await callAppApi<Array<{ ID: string; label: string; issuer: string }>>({
      baseUrl: spoke.appUrl,
      method: "GET",
      path: "/api/openid/providers",
      headers: { Authorization: `Bearer ${apiKey}` },
      errorLabel: "Immich",
    }).catch(() => [] as Array<{ ID: string; label: string; issuer: string }>);
    const list = Array.isArray(existing) ? existing : [];
    if (list.some((p) => p.label === "HexOS" && p.issuer === spoke.issuer)) {
      ctx.log("Immich OIDC provider already registered");
      return false;
    }

    const oidcConfig = buildOidcConfig(spoke);
    await callAppApi({
      baseUrl: spoke.appUrl,
      method: "POST",
      path: "/api/openid/providers",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: oidcConfig,
      errorLabel: "Immich",
    });
    ctx.log("Immich OIDC provider registered via Admin API");
    return true;
  };

  const verifyCallback = async (spoke: SpokeContext) => {
    try {
      const providers = await callAppApi<Array<{ ID: string; label: string; issuer: string }>>({
        baseUrl: spoke.appUrl,
        method: "GET",
        path: "/api/openid/providers",
        headers: { Authorization: `Bearer ${apiKey}` },
        errorLabel: "Immich",
      }).catch(() => [] as Array<{ ID: string; label: string; issuer: string }>);
      const list = Array.isArray(providers) ? providers : [];
      const registered = list.find((p) => p.label === "HexOS" && p.issuer === spoke.issuer);
      if (registered) {
        ctx.log(`OIDC provider "${registered.label}" verified — users can log in via Authentik`);
      } else {
        ctx.log(`OIDC provider not listed — check Immich Settings → Authentication Providers`);
      }
    } catch (err) {
      ctx.log(`OIDC verification failed: ${(err as Error).message}`);
    }
  };

  // One-call SSO lifecycle (manifest → create/reuse spoke → configure → verify → summary)
  await defineSsoSpoke(ctx, {
    appId: "immich",
    appTitle: "Immich",
    redirectUriPath: CALLBACK_PATH,
    appUrl: baseUrl,
    configure: configureCallback,
    verify: verifyCallback,
  });
}
