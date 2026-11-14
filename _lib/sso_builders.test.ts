import { expect, test } from "bun:test";
import type { SpokeContext } from "../authentik/types";
import { buildOidcConfig as buildJellyfinConfig } from "../jellyfin/jellyfin_sso";
import { buildOidcConfig as buildImmichConfig } from "../immich/immich_sso";
import { buildOidcConfigBlock as buildNextcloudConfig } from "../nextcloud/nextcloud_sso";

/** A representative SpokeContext for testing. */
const spoke: SpokeContext = {
    provider: {
        name: "truenas-jellyfin",
        slug: "jellyfin",
        client_id: "abc-123-client-id",
        client_secret: "abc-123-client-secret",
    },
    application: {
        name: "jellyfin-app",
        slug: "jellyfin-app",
    },
    issuer: "https://sso.example.com",
    apiBase: "https://sso.example.com/api/v3",
    discoveryUrl: "https://sso.example.com/application/o/.well-known/openid-configuration",
    oidc: {
        authorizationEndpoint: "https://sso.example.com/application/o/authorize/",
        tokenEndpoint: "https://sso.example.com/application/o/token/",
        userinfoEndpoint: "https://sso.example.com/application/o/userinfo/",
        jwksEndpoint: "https://sso.example.com/application/o/jwks/",
        endSessionEndpoint: "https://sso.example.com/application/o/end-session/",
    },
    appUrl: "http://jellyfin.example.com:8096",
    redirectUri: "http://jellyfin.example.com:8096/oauth/oidc",
};

test("jellyfin buildOidcConfig produces correct shape", () => {
    const config = buildJellyfinConfig(spoke);

    // Identity
    expect(config.displayName).toBe("Authentik");
    expect(config.enable).toBe(true);

    // Client credentials from spoke
    expect(config.clientId).toBe("abc-123-client-id");
    expect(config.clientSecret).toBe("abc-123-client-secret");

    // OIDC endpoints from spoke
    expect(config.authorizationEndpoint).toBe("https://sso.example.com/application/o/authorize/");
    expect(config.tokenEndpoint).toBe("https://sso.example.com/application/o/token/");
    expect(config.userInfoEndpoint).toBe("https://sso.example.com/application/o/userinfo/");
    expect(config.metadataAddress).toBe("https://sso.example.com/application/o/.well-known/openid-configuration");

    // Redirect URI from spoke (not manually constructed)
    expect(config.redirectUri).toBe("http://jellyfin.example.com:8096/oauth/oidc");
    expect(config.callbackUri).toBe("http://jellyfin.example.com:8096/oauth/oidc");

    // Logout uses the app URL
    expect(config.logoutUri).toBe("http://jellyfin.example.com:8096/Users/Login/Logout?returnTo=/");

    // Protocol settings
    expect(config.scope).toBe("openid email name");
    expect(config.response_type).toBe("code");
    expect(config.grant_type).toBe("authorization_code");
});

test("immich buildOidcConfig produces correct shape", () => {
    const immichSpoke: SpokeContext = {
        ...spoke,
        provider: { ...spoke.provider, slug: "immich", name: "truenas-immich" },
        application: { name: "immich-app", slug: "immich-app" },
        appUrl: "http://immich.example.com:2283",
        redirectUri: "http://immich.example.com:2283/web/auth/openid-form",
    };

    const config = buildImmichConfig(immichSpoke);

    // Identity
    expect(config.label).toBe("HexOS");
    expect(config.issuer).toBe("https://sso.example.com");

    // Client credentials
    expect(config.client_id).toBe("abc-123-client-id");
    expect(config.client_secret).toBe("abc-123-client-secret");

    // OIDC endpoints
    expect(config.authorization_endpoint).toBe("https://sso.example.com/application/o/authorize/");
    expect(config.token_endpoint).toBe("https://sso.example.com/application/o/token/");
    expect(config.userinfo_endpoint).toBe("https://sso.example.com/application/o/userinfo/");
    expect(config.end_session_endpoint).toBe("https://sso.example.com/application/o/end-session/");

    // Auth settings
    expect(config.scope).toBe("openid email profile");
    expect(config.use_pkce).toBe(true);
    expect(config.create_user).toBe(true);

    // Logo points to authentik's static assets
    expect(config.logo_url).toBe("https://sso.example.com/static/favicon-96x96.png");
});

test("nextcloud buildOidcConfigBlock produces correct PHP", () => {
    const ncSpoke: SpokeContext = {
        ...spoke,
        provider: { ...spoke.provider, slug: "nextcloud", name: "truenas-nextcloud" },
        application: { name: "nextcloud-app", slug: "nextcloud-app" },
        appUrl: "http://cloud.example.com",
        redirectUri: "http://{{ nextcloudHost }}/login",
    };

    const block = buildNextcloudConfig(ncSpoke);

    // Contains the client credentials
    expect(block).toContain("'oidc_login_client_id' => 'abc-123-client-id'");
    expect(block).toContain("'oidc_login_secret' => 'abc-123-client-secret'");

    // Contains the authorization endpoint
    expect(block).toContain("'oidc_login_provider_endpoint' => 'https://sso.example.com/application/o/authorize/'");

    // Logout redirect uses URL-encoded redirect URI
    expect(block).toContain(`redirect_uri=${encodeURIComponent("http://{{ nextcloudHost }}/login")}`);

    // Button label
    expect(block).toContain("'oidc_login_login_button_label' => 'Log in via HexOS'");

    // Valid PHP array entries (each line ends with comma)
    const lines = block.trim().split("\n").filter((l) => l.trim().startsWith("'"));
    for (const line of lines) {
        expect(line.trimEnd()).toMatch(/',\s*$/);
    }
});

test("all builders use spoke.redirectUri (not hardcoded paths)", () => {
    // Change the redirect URI and verify it flows through
    const customSpoke: SpokeContext = {
        ...spoke,
        redirectUri: "https://custom.example.com/callback",
    };

    const jf = buildJellyfinConfig(customSpoke);
    expect(jf.redirectUri).toBe("https://custom.example.com/callback");
    expect(jf.callbackUri).toBe("https://custom.example.com/callback");

    const nc = buildNextcloudConfig(customSpoke);
    expect(nc).toContain(`redirect_uri=${encodeURIComponent("https://custom.example.com/callback")}`);
});
