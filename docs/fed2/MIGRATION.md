# Migrating to @mercuriusjs/gateway v6 and @mercuriusjs/federation v6

## Gateway

1. Upgrade both packages. No option is required; Federation 1 subgraphs keep working.
2. Start the gateway once. Composition errors (`MER_ERR_GQL_GATEWAY_COMPOSITION`) list every SDL
   conflict with a code; fix them in the subgraphs. The common ones from v5 installations:
   - `FIELD_TYPE_MISMATCH` / `EXTERNAL_TYPE_MISMATCH`: same field, different type or nullability.
   - `KEY_INVALID_FIELDS`: `@key(fields:)` names a field the subgraph does not declare (declare it `@external`).
   - `EXTERNAL_MISSING_ON_BASE`: a field is `@external` in every subgraph that has it.
   - `SATISFIABILITY_ERROR`: a field cannot be reached from where its parent is produced (usually a missing `@key`).
3. Review the behaviour changes listed under "Migrating from v5" in the README (request counts for hooks,
   `@requires` no longer in the gateway schema, empty reference lists, null entities, field order).
4. Optional: `gateway.queryPlan.expose` and `app.graphqlGateway.explain()` show how each operation is executed;
   `app.graphqlGateway.supergraphSdl` can be published to a registry, and `gateway.supergraphSdl` lets the
   gateway run from a registry-provided supergraph.

## Subgraphs

Federation 1 SDLs are accepted as they are and logged once as Federation 1. To move a subgraph to
Federation 2:

```sh
npx mercurius-federation-upgrade --version 2.3 users.graphql posts.graphql
```

This adds `extend schema @link(...)` with the directives the SDL uses, turns `extend type X @key` into
`type X @key`, and marks value types and entity fields shared across the given SDLs `@shareable`. Review the
output (comments are not preserved), then adopt the Federation 2 directives you need: `@override(from:)`
to move a field between subgraphs, `@inaccessible` to hide fields from the API schema, `@interfaceObject`
for interface entities, `@composeDirective` to keep a custom directive in the supergraph.
