// Authentic blueprint YAML — exported for consumption by the SSO setup hook.
export const BLUEPRINT_YAML = `version: 1
entries:
  # LDAP Provider — binds as the authenticating user
  - model: authentik_providers_ldap.ldapprovider
    identifiers:
      name: truenas-ldap
    attrs:
      bind_flow: default-bind-flow
      bind_username_template: "{{ user.username }}"
      bind_password_template: "{{ user.password }}"
      mode: default
      start_tls: false
      use_tls: false

  # Application — pairs the provider with the outpost
  - model: authentik_core.application
    identifiers:
      name: truenas-ldap
      slug: truenas
    attrs:
      provider: truenas-ldap

  # Service account — dedicated user for LDAP directory binds
  - model: authentik_core.user
    identifiers:
      username: ldapservice
    attrs:
      name: LDAP Service Account
      is_active: true

  # Role — grants the service account directory search
  - model: authentik_rbac.role
    identifiers:
      name: LDAP Search Role
    attrs:
      group_type: local
      users:
        - ldapservice

  # Docker service connection — lets the outpost run as a container
  - model: authentik_outposts.dockerserviceconnection
    identifiers:
      name: truenas-ldap-docker
    attrs:
      local: true
      url: unix:///var/run/docker.sock

  # LDAP Outpost — the actual LDAP server on port 389
  - model: authentik_outposts.outpost
    identifiers:
      name: truenas-ldap-outpost
      slug: truenas
    attrs:
      port: 389
      type: ldap
      service_connection: truenas-ldap-docker
      applications:
        - truenas

  # LDAP Group — all LDAP-bound users go here so spokes can manage access via group policies
  - model: authentik_core.user
    identifiers:
      username: hexos-ldap-group
    attrs:
      name: HexOS LDAP Group
      is_active: true
      username: hexos-ldap-group
`;
