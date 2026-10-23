import type { HookContext } from "../_lib/hook_context";

// Seer's media server binding, from /api/v1/settings/public
const MEDIA_SERVER_NOT_CONFIGURED = 0;
const MEDIA_SERVER_PLEX = 1;
const MEDIA_SERVER_JELLYFIN = 2;
const MEDIA_SERVER_EMBY = 3;

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Locating Seer" },
    { id: "precheck", message: "Checking Seer's media server" },
    { id: "auth", message: "Signing in to Seer with Jellyfin" },
    { id: "verify", message: "Verifying the connection" },
  ]);

  const seerUrl = await ctx.getInstalledAppUrl("seerr");
  if (!seerUrl) throw new Error("Seer is not installed or has no reachable port");
  if (!ctx.host || !ctx.port) throw new Error("Missing Jellyfin host/port in action context");
  await ctx.emitCheckpoint("locate");

  const publicResponse = await fetch(`${seerUrl}/api/v1/settings/public`);
  if (!publicResponse.ok) throw new Error(`Could not read Seer's settings (${publicResponse.status})`);
  const publicSettings = (await publicResponse.json()) as { initialized?: boolean; mediaServerType?: number };
  if (typeof publicSettings.initialized !== "boolean") throw new Error("Could not confirm Seer's setup state");
  const hasJellyfin = publicSettings.mediaServerType === MEDIA_SERVER_JELLYFIN;
  if (!hasJellyfin && (publicSettings.initialized || publicSettings.mediaServerType !== MEDIA_SERVER_NOT_CONFIGURED)) {
    const server =
      publicSettings.mediaServerType === MEDIA_SERVER_PLEX
        ? "Plex"
        : publicSettings.mediaServerType === MEDIA_SERVER_EMBY
          ? "Emby"
          : "another media";
    const message =
      publicSettings.mediaServerType === MEDIA_SERVER_PLEX || publicSettings.mediaServerType === MEDIA_SERVER_EMBY
        ? `Seer is already connected to ${server} server`
        : "Could not verify Seer's existing media-server setup";
    ctx.fail(message, [
      { label: "Why", value: "This link preserves Seer's existing media server" },
      { label: "Fix", value: "Manage the media server in Seer manually. Its existing setup was left unchanged." },
    ]);
  }
  await ctx.emitCheckpoint("precheck");

  const username = ctx.getInput<string>("admin_username");
  const password = ctx.getInput<string>("admin_password");
  const authResponse = await fetch(`${seerUrl}/api/v1/auth/jellyfin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      ...(hasJellyfin ? {} : { hostname: ctx.host, port: ctx.port, useSsl: false, urlBase: "" }),
      serverType: MEDIA_SERVER_JELLYFIN,
    }),
  });
  if (authResponse.status === 401) {
    throw new Error("Seer rejected the Jellyfin username or password");
  }
  if (!authResponse.ok) {
    throw new Error(`Seer's Jellyfin sign-in failed (${authResponse.status})`);
  }
  const cookie = cookieFrom(authResponse);
  if (!cookie) throw new Error("Seer sign-in returned no session cookie");
  await ctx.emitCheckpoint("auth");

  const bindingResponse = await fetch(`${seerUrl}/api/v1/settings/jellyfin`, { headers: { Cookie: cookie } });
  if (!bindingResponse.ok) throw new Error(`Could not read Seer's Jellyfin connection (${bindingResponse.status})`);
  const binding = (await bindingResponse.json()) as { ip?: string; port?: number; useSsl?: boolean; urlBase?: string };
  if (binding.ip !== ctx.host || binding.port !== ctx.port || binding.useSsl !== false || binding.urlBase !== "") {
    throw new Error(
      "Seer is already connected to another Jellyfin server or URL. Connect it manually to preserve its existing setup.",
    );
  }
  if (!publicSettings.initialized) {
    const initialize = await fetch(`${seerUrl}/api/v1/settings/initialize`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    if (!initialize.ok) throw new Error(`Could not complete Seer's setup (${initialize.status})`);
  }

  const verifyResponse = await fetch(`${seerUrl}/api/v1/settings/public`);
  if (!verifyResponse.ok) throw new Error(`Could not verify Seer's settings (${verifyResponse.status})`);
  const verified = (await verifyResponse.json()) as { mediaServerType?: number; initialized?: boolean };
  if (verified.mediaServerType !== MEDIA_SERVER_JELLYFIN || verified.initialized !== true) {
    throw new Error("Seer's Jellyfin setup could not be verified as complete");
  }
  await ctx.emitCheckpoint("verify");
}
