# Draft: upstream interest check

To post on https://github.com/mercurius-js/mercurius-gateway/issues and
https://github.com/mercurius-js/mercurius-federation/issues (same text, adjusted title).

---

**Title:** Apollo Federation 2 support (composition, query planner, `@link` subgraphs)

I have a working Federation 2 implementation for both packages and would like to know whether you
would take it upstream before I polish it into PRs.

What it does

- `@mercuriusjs/federation`: parses `@link` (v2.0–v2.9, imports, aliases, `federation__` prefix), injects
  the right directive definitions per version, keeps `_service { sdl }` byte-identical, supports repeatable
  `@key`, `@interfaceObject` entities, and ships `upgradeSubgraphSdl()` + a bin to convert Federation 1 SDLs.
  Federation 1 SDLs are untouched. Branch: https://github.com/dwelch2344/mercurius-federation/tree/feat/fed2-link
- `@mercuriusjs/gateway`: composes subgraphs with `@theguild/federation-composition` (MIT; Apollo's
  composition is ELv2 so nothing from it is used) and replaces the per-field resolvers with a query
  planner: root fetches per subgraph, `_entities` hops keyed on satisfiable `@key`s, `@requires`/`@provides`,
  `@override`, `@inaccessible`, interfaces/unions, `@interfaceObject`, multi-hop key translation, batching
  per subgraph, `explain()` / `extensions.queryPlan`, and running from a precomposed supergraph SDL.
  The existing suite passes on the planner (fixtures with inconsistent SDLs had to be fixed since
  composition is strict), plus Federation 2 end-to-end tests and a gateway-side run of the Apollo
  subgraph compatibility schemas. Branch: https://github.com/dwelch2344/mercurius-gateway/tree/feat/fed2-composition
- Conformance: a `mercurius-federation` implementation for apollographql/apollo-federation-subgraph-compatibility.

What changes for users

- New majors for both packages. Behavioural differences are listed in the gateway README
  ("Migrating from v5"); the main one is that conflicting subgraph SDLs now fail at startup.
- One new runtime dependency on the gateway (`@theguild/federation-composition`), `single-user-cache` dropped.

Questions

1. Would you accept this as the v6 line of both packages?
2. Any objection to the Guild composition dependency?
3. Preferred split: one PR per package, or several (composition, planner, docs)?
