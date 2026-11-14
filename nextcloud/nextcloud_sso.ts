// Sibling files are type imports only: each script compiles standalone.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

import type { ContextMount, HookContext } from "../_lib/hook_context";
import type { SpokeContext } from "../authentik/types";
import {
  configMount as _configMount,
  requireAppInfo,
  defineSsoSpoke,
} from "../authentik/client";

/**
 * Configures Nextcloud to authenticate via Authentik OIDC (enable-sso).
 *
 * Flow:
 * 1. Read the SSO manifest via platform-discovered mounts to discover authentik's API URL and bootstrap token.
 * 2. Create an on-demand OAuth2 provider and application in authentik.
 * 3. Write Nextcloud's OIDC configuration into config/config.php.
 * 4. Enable the oidc_login app via OCC.
 */

/** OIDC callback/redirect URL — after auth user returns to Nextcloud login. */
const REDIRECT_URI = "http://{{ nextcloudHost }}/login";

/** Resolve Nextcloud's HTML mount — prefer /www/nextcloud, fall back to containerPath. */
const configMount = (mounts: ContextMount[]): ContextMount | undefined =>
  _configMount(mounts, [
    (m) => m.localPath.endsWith("/nextcloud/html"),
    (m) => m.containerPath === "/var/www/html",
  ]);



/**
 * Build the oidc_login config block for Nextcloud's config.php.
 * Exported for unit testing in _lib/.
 */
export function buildOidcConfigBlock(spoke: SpokeContext): string {
  return `
  'oidc_login_provider_endpoint' => '${spoke.oidc.authorizationEndpoint}',
  'oidc_login_client_id' => '${spoke.provider.client_id}',
  'oidc_login_secret' => '${spoke.provider.client_secret}',
  'oidc_login_login_button_label' => 'Log in via HexOS',
  'oidc_login_login_button_class' => 'button primary',
  'oidc_login_logout_redirect' => '${spoke.oidc.authorizationEndpoint}?client_id=${spoke.provider.client_id}&redirect_uri=${encodeURIComponent(spoke.redirectUri)}&response_type=code&prompt=logout',
  'oidc_login_map_field' => 'email',
`;
}

/**
 * Write OIDC config into Nextcloud's config.php.
 *
 * Strategy: find the $CONFIG line in config.php and inject the oidc_login block
 * right after it. Returns `true` if the config was written, `false` if already present.
 */
export function writeOidcConfig(
  configPath: string,
  spoke: SpokeContext,
): boolean {
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`Nextcloud config.php not found at ${configPath}. ` +
      "Is the Nextcloud html mount correctly configured?");
  }

  // Idempotency: skip if the client_id is already configured.
  if (content.includes(`'oidc_login_client_id' => '${spoke.provider.client_id}'`)) {
    return false;
  }

  const oidcBlock = buildOidcConfigBlock(spoke);

  // Insert the block after the opening <?php and $CONFIG = []; line.
  const configStart = "$CONFIG = array();";
  if (content.includes(configStart)) {
    content = content.replace(
      configStart,
      configStart + oidcBlock,
    );
    writeFileSync(configPath, content);
    // Ensure the file is writable (sometimes SELinux/container perms get strict).
    try {
      chmodSync(configPath, 0o664);
    } catch {
      // Best effort — Nextcloud may need manual permission adjustment.
    }
    return true;
  } else {
    throw new Error(
      "Nextcloud config.php doesn't contain the expected $CONFIG array. " +
      "The file may be corrupted or use an unexpected format.",
    );
  }
}

export async function afterInstall(ctx: HookContext) {
  const { baseUrl, mounts } = await requireAppInfo(ctx, "nextcloud", "Nextcloud");
  const nextcloudMount = configMount(mounts);
  if (!nextcloudMount) {
    ctx.fail("HexOS couldn't find Nextcloud's html mount. Is Nextcloud installed?", [
      { label: "Mounts inspected", value: mounts.length === 0 ? "(none — is the app installed?)" : mounts.map((m) => m.hostPath).join(", ") },
    ]);
  }
  const configPath = nextcloudMount.localPath + "/config/config.php";

  const configureCallback = async (spoke: SpokeContext): Promise<boolean> => {
    const didWork = writeOidcConfig(configPath, spoke);
    if (didWork) {
      ctx.log("Nextcloud oidc_login config written");
      ctx.log("Ensure the 'oidc_login' app is installed in Nextcloud Apps.");
    }
    return didWork;
  };

  // One-call SSO lifecycle (manifest → create/reuse spoke → configure → verify → summary).
  // Nextcloud's verify step is intentionally a no-op; the checkpoint is still
  // registered and emitted by the shared runner.
  await defineSsoSpoke(ctx, {
    appId: "nextcloud",
    appTitle: "Nextcloud",
    redirectUri: REDIRECT_URI,
    appUrl: baseUrl,
    configure: configureCallback,
  });
}
