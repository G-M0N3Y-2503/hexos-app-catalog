// Shared SSO type definitions for the authentik hub-and-spoke architecture.
// Zero runtime cost — all type-only exports.

import type { ContextMount } from "../_lib/hook_context";

export interface SsoManifest {
  version: number;
  generatedBy: string;
  issuer: string;
  /**
   * Canonical authentik OIDC endpoints for the shared /application/o server.
   * Endpoints are shared across all providers — the client_id selects the
   * provider/application. The hub populates this via `discoverOidc(issuer)`,
   * the same source of truth the spokes use.
   */
  oidc: AuthentikOidcEndpoints;
  ldap: {
    endpoint: string;
    baseDn: string;
  };
  token: string;
}

/**
 * Canonical OIDC endpoints for an authentik issuer.
 *
 * Derived from the issuer base by `discoverOidc()` — spokes never hardcode
 * authentik's internal paths, which is what previously let them drift apart.
 */
export interface AuthentikOidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  jwksEndpoint: string;
  endSessionEndpoint: string;
}

export interface AuthentikProvider {
  name: string;
  slug: string;
  client_id: string;
  client_secret: string;
  authorization_flow?: string;
  token_flow?: string;
}

export interface AuthentikApplication {
  name: string;
  slug: string;
  provider?: { slug: string; name: string };
}

export interface AuthentikOutpost {
  name: string;
  slug: string;
  type: string;
  port: number;
}

export interface SpokeRegistration {
  providerSlug: string;
  providerName: string;
  applicationSlug: string;
  applicationName: string;
}

/** Configuration for creating an on-demand SSO spoke in authentik. */
export interface SpokeSsoConfig {
  providerSlug: string;
  providerDisplay: string;
}

/** Result of creating (or reusing) an SSO spoke in authentik. */
export interface SpokeSsoResult {
  provider: AuthentikProvider;
  application: AuthentikApplication;
}

/** Context passed to configure/verify callbacks — the created spoke + the issuer to wire it into. */
export interface SpokeContext {
  provider: AuthentikProvider;
  application: AuthentikApplication;
  /** Public base URL of authentik (the OIDC issuer), e.g. https://sso.example.com. */
  issuer: string;
  /** Authentik admin API base (issuer + /api/v3) — for provider/application management. */
  apiBase: string;
  /** Per-issuer OIDC discovery document — a single URL most OIDC clients can consume as-is. */
  discoveryUrl: string;
  /** Canonical authentik OIDC endpoints, derived from the issuer. */
  oidc: AuthentikOidcEndpoints;
  /** The target app's URL — resolved by the spoke helper. */
  appUrl: string;
  /**
   * The OIDC redirect URI for this spoke. Computed by the helper from
   * `redirectUriPath` (appended to appUrl) or a full `redirectUri` override.
   */
  redirectUri: string;
}

/** Configuration for `runSsoFlow()` lifecycle runner. */
export interface RunSsoFlowConfig {
  providerSlug: string;
  providerDisplay: string;
  configureCheckpoint: string;
  verifyCheckpoint: string;
}
