# Apollo Federation 2 for Mercurius — implementation plan

Issue: https://github.com/dwelch2344/mercurius-gateway/issues/1
Date: 2026-10-18. Baseline: `@mercuriusjs/gateway` 5.2.0, `@mercuriusjs/federation` 5.1.1, 204/204 tests green.

## 0. Findings from the audit (what changes the plan)

1. **The gateway has no query planner.** Execution is graphql-js running the composed schema; each field gets a
   resolver from `defineResolvers` (`lib/gateway/build-gateway.js`) that either reads from the parent or calls
   `makeResolver` (`lib/gateway/make-resolver.js`) to send a `Query_*` or `_entities` request. Per-request
   batching of `_entities` calls is done by `single-user-cache` keyed on service. "Query planning" in this codebase
   means: (a) `typeToServiceMap` / `typeFieldsToService` (ownership), (b) `collectServiceTypeFields` (prune the
   selection set to what the target service has), (c) `removeNonIdProperties` (build representations).
2. **Ownership is derived from Fed 1 syntax only.** `createTypeMap` in `service-map.js` classifies `extend type` /
   `@extends` / `@requires` as extensions; `findValueTypes` treats any type defined by 2+ services without `@key`
   as a value type. Fed 2 has no extension concept, so this derivation is the thing to replace, not patch.
3. **`@link` is silently dropped today.** `buildFederationSchema` skips `SchemaDefinition`/`SchemaExtension`
   nodes and uses `assumeValidSDL`, so a Fed 2 SDL "builds" but with no `@link` semantics, no namespacing, no
   `@shareable`/`@override`/`@inaccessible` definitions, and `@key` not `repeatable`.
4. **Keys are flat-only.** `removeNonIdProperties` and `getRequiredFields` do `fields.split(' ')`. Composite keys
   (`study { caseNumber }`), multiple `@key`s, and nested `@requires` (`dimensions { size weight }`) all break.
   All three are in the Apollo conformance schema.
5. **An MIT composition library already exists.** `@theguild/federation-composition` (MIT, deps: debug, json5,
   constant-case, lodash.sortby; peer graphql ^16||^17) is an API-identical replacement for `@apollo/composition`
   (ELv2). Verified locally (`scratchpad/exp/compose.js`):
   - composes Fed 2 subgraphs with `@shareable`/`@override`/`@inaccessible` and emits supergraph SDL whose
     `@join__type(graph, key, isInterfaceObject)` / `@join__field(graph, override, external, requires, provides)`
     directives are exactly the ownership index the gateway needs;
   - composes **Fed 1 style subgraphs** (`extend type`, no `@link`) with the same output shape, so one code path
     serves both;
   - emits `publicSdl` with `@inaccessible` already stripped;
   - returns Apollo-compatible errors (`Non-shareable field "T.x" is resolved from multiple subgraphs ...`).
6. **Apollo's conformance suite already has `implementations/mercurius`,** but it is built on `@apollo/subgraph`,
   not `@mercuriusjs/federation`. The suite tests the *subgraph* side only (the router is Apollo's). Gateway-side
   conformance has to be our own test that composes the suite's `users` + `inventory` + `products` schemas and
   runs the suite's queries.

**Decisions (2026-10-18):**
1. Composition: `@theguild/federation-composition` (MIT). Hand-rolled composition only if it proves incompatible.
2. Delivery: new majors, `@mercuriusjs/gateway` 6 and `@mercuriusjs/federation` 6. Fed 2 composition + planner are
   the default; Fed 1 subgraphs keep working through the same path (auto-detected, no `@link` ⇒ v1 semantics).
3. First slice: `@link` + `@shareable` + `@override` + `@inaccessible`.
4. Execution: a real **plan-then-execute query planner** replaces the resolver-per-field model (§4).
5. Tooling/integration/migration are in scope (§5): precomposed supergraph input, `supergraphSdl` output, query
   plan exposure, v1→v2 SDL upgrade helper.

## 1. Workspace layout

```
~/work/mercurius-fed2/
├── mercurius-gateway/                      # this fork (dwelch2344/mercurius-gateway), branch feat/federation-v2
├── mercurius-federation/                   # fork of mercurius-js/mercurius-federation, branch feat/federation-v2
├── mercurius/                              # mercurius-js/mercurius — read-only reference (replaceSchema, hooks, loaders)
├── apollo-federation-subgraph-compatibility/  # fork of apollographql/… — add implementations/mercurius-federation
├── federation-composition/                 # the-guild-org/federation-composition — read-only, MIT (debug supergraph output)
└── apollo-federation/                      # apollographql/federation — READ-ONLY spec/docs reference. ELv2. No code copied.
```

Local linking during development (gateway consumes the in-progress federation package):

```
# mercurius-gateway/package.json (dev only, revert before release)
"@mercuriusjs/federation": "file:../mercurius-federation"
```

Repos the session needs attached: `dwelch2344/mercurius-federation` (fork to be created) and, for the conformance
PR, `dwelch2344/apollo-federation-subgraph-compatibility`.

## 2. Target file tree

### 2.1 `mercurius-federation` (subgraph side) — new/changed

```
lib/
├── federation.js            MOD  detect @link → fed2 mode; keep schema extension; inject versioned defs; _Entity includes @interfaceObject types
├── link.js                  NEW  parseFederationLink(document) → { version:{major,minor}, imports:Map<canonical,alias>, namespace:'federation'|as }
├── specs.js                 NEW  Fed 2 directive/scalar SDL per version (our own text, written from the public spec)
├── naming.js                NEW  linkedName(imports, namespace, '@key') → 'key' | 'federation__key'; applyLinkNaming(doc)
├── compositionRules.js      MOD  allow repeatable @key / unknown-but-linked directives
├── util.js                  MOD  hasExtensionDirective: in fed2 mode only `@extends` marks an extension (not `@requires`)
└── errors.js                MOD  MER_ERR_GQL_FEDERATION_UNSUPPORTED_VERSION, MER_ERR_GQL_FEDERATION_UNKNOWN_IMPORT
test/
├── fed2/link.js             @link parsing, aliases ({name:"@key", as:"@primaryKey"}), federation__ prefix when not imported
├── fed2/service-sdl.js      _service { sdl } returns the original SDL including `extend schema @link`
├── fed2/entities.js         multiple @key, composite key, @interfaceObject in _Entity, resolvable:false
├── fed2/directives.js       @shareable/@override/@inaccessible/@tag/@composeDirective present in schema
└── fed2/compat-products.js  the Apollo products.graphql builds + resolves the suite's data
index.d.ts                   MOD  option `federation?: { version?: '1'|'2' }` (auto-detect by default)
```

Shape of `lib/specs.js` (illustrative):

```js
// versions: 2.0 … 2.9. Each entry: { since:[major,minor], sdl }
module.exports.FEDERATION_DIRECTIVES = [
  { since: [2, 0], sdl: 'directive @key(fields: FieldSet!, resolvable: Boolean = true) repeatable on OBJECT | INTERFACE' },
  { since: [2, 0], sdl: 'directive @shareable repeatable on OBJECT | FIELD_DEFINITION' },
  { since: [2, 0], sdl: 'directive @override(from: String!, label: String) on FIELD_DEFINITION' },
  { since: [2, 0], sdl: 'directive @inaccessible on FIELD_DEFINITION | OBJECT | INTERFACE | UNION | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION' },
  { since: [2, 0], sdl: 'directive @tag(name: String!) repeatable on FIELD_DEFINITION | OBJECT | INTERFACE | UNION | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION | SCHEMA' },
  { since: [2, 0], sdl: 'directive @external on OBJECT | FIELD_DEFINITION' },
  { since: [2, 0], sdl: 'directive @requires(fields: FieldSet!) on FIELD_DEFINITION' },
  { since: [2, 0], sdl: 'directive @provides(fields: FieldSet!) on FIELD_DEFINITION' },
  { since: [2, 0], sdl: 'directive @extends on OBJECT | INTERFACE' },
  { since: [2, 1], sdl: 'directive @composeDirective(name: String!) repeatable on SCHEMA' },
  { since: [2, 3], sdl: 'directive @interfaceObject on OBJECT' },
  { since: [2, 0], sdl: 'scalar FieldSet' }
]
module.exports.LINK_SPEC = `
  directive @link(url: String!, as: String, for: link__Purpose, import: [link__Import]) repeatable on SCHEMA
  scalar link__Import
  enum link__Purpose { SECURITY EXECUTION }
`
```

### 2.2 `mercurius-gateway` — new/changed

```
lib/
├── gateway/
│   ├── build-gateway.js         MOD  compose via lib/compose; register preExecution planner hook; root resolvers read plan result
│   ├── service-map.js           MOD  keep parsed DocumentNode + detected fed version per service; drop createTypeMap in v2 path
│   ├── make-resolver.js         DEL  (phase 7) replaced by planner; subscriptions' root subscribe moves to planner/subscribe.js
│   ├── find-value-types.js      KEEP (v1 path only; deleted when v1 composition is removed)
│   ├── get-query-result.js      KEEP
│   └── request.js               KEEP
├── compose/
│   ├── index.js                 NEW  composeSupergraph(services) → { schema, planIndex, supergraphSdl, publicSdl }
│   ├── plan-index.js            NEW  buildPlanIndex(supergraphDocumentNode) → PlanIndex
│   ├── schema-from-supergraph.js NEW  executable GraphQLSchema: strip join__/link, apply @inaccessible, keep custom + composed directives
│   └── errors.js                NEW  MER_ERR_GQL_GATEWAY_COMPOSITION (wraps Guild GraphQLErrors; keeps `extensions.code`)
├── planner/
│   ├── index.js                 NEW  { buildQueryPlan, executePlan, printPlan }
│   ├── nodes.js                 NEW  Sequence / Parallel / Fetch / Condition constructors + JSON serializer
│   ├── build-query-plan.js      NEW  DocumentNode + PlanIndex → plan (§4.3)
│   ├── owner.js                 NEW  pickOwner({ planIndex, typeName, fieldName, currentGraph, availableKeys })
│   ├── paths.js                 NEW  key-bridge search: which graph can turn the keys we have into a key the owner accepts
│   ├── field-set.js             NEW  parseFieldSet('sku variation { id }') → SelectionSet; satisfiedBy(obj, selectionSet)
│   ├── fetch-document.js        NEW  build/print the per-Fetch operation (root or `_entities`), variable pruning, fragments
│   ├── execute-plan.js          NEW  run the tree, collect representations by path, merge entities, map errors (§4.4)
│   ├── cache.js                 NEW  plan LRU keyed by schema version + operation + document hash
│   └── print-plan.js            NEW  human-readable plan for `explain()` and test snapshots
├── errors.js                    MOD  new error codes
└── util.js                      MOD  remove `requires`-as-extension marker from v2 path
index.d.ts                       MOD  gateway.federation?: { version?: 1 | 2 }, gateway.composition?: { onError?, allowV1? }
README.md                        MOD  Fed 2 section + migration notes
docs/fed2/                       this plan + ADR for the Guild dependency
test/
├── fed2/
│   ├── link-shareable.js        first slice: two subgraphs both defining a @shareable value type + entity fields
│   ├── override.js              @override(from:) routes to the new owner; old owner never queried
│   ├── inaccessible.js          field/type absent from introspection and rejected in queries
│   ├── multiple-keys.js         entity with 3 @keys, parent only has sku+package
│   ├── composite-keys.js        @key(fields: "study { caseNumber }")
│   ├── requires-nested.js       @requires(fields: "dimensions { size weight }")
│   ├── provides.js              @provides short-circuits the extra hop
│   ├── interface-object.js      @interfaceObject + interface @key
│   ├── compose-directive.js     @composeDirective'd custom directive survives composition
│   ├── mixed-v1-v2.js           one Fed 1 subgraph + one Fed 2 subgraph
│   ├── composition-errors.js    non-shareable duplicate, override cycle, missing base → MER_ERR_GQL_GATEWAY_COMPOSITION
│   └── refresh.js               pollingInterval re-composition with v2 subgraphs
├── conformance/
│   ├── apollo-compat.js         composes fixtures below with OUR gateway, runs the suite's queries, asserts expected data
│   └── fixtures/{users,inventory,products}.js   the three COMPATIBILITY.md schemas + data, served by @mercuriusjs/federation
└── utils/create-fed2-service.js NEW
```

### 2.3 `apollo-federation-subgraph-compatibility` fork

```
implementations/mercurius-federation/      # NEW, copied from _template_library_
├── Dockerfile                            node:22-alpine, npm ci, node index.js, EXPOSE 4001
├── docker-compose.yaml                   services.products.build: implementations/mercurius-federation
├── index.js                              products schema via @mercuriusjs/federation (NOT @apollo/subgraph)
├── products.graphql                      copy of _template_library_/products.graphql (v2.3 incl. @interfaceObject, @composeDirective)
├── metadata.json                         federationLibrary → @mercuriusjs/federation
└── package.json
.github/workflows/test-subgraph-mercurius-federation.yaml   from template
```

Run locally: `make setup && make test subgraph=mercurius-federation` (needs Docker + Rover; results land in
`results.md`). Target: all 15 rows ✓ including `@interfaceObject` and `@composeDirective`.

## 3. Core data structure: `PlanIndex`

Built once per composition from `supergraphDocumentNode`; replaces `typeToServiceMap`, `typeFieldsToService`,
`service.typeMap`, `service.extensionTypeMap`, `findValueTypes`.

```js
PlanIndex = {
  graphs: { [enumValue]: { name: 'users', url } },             // from enum join__Graph
  types: {
    [typeName]: {
      kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR',
      graphs: {
        [graphName]: {
          keys: [SelectionSet],        // parsed @join__type(key:) per graph; [] for value types
          resolvable: true,
          isInterfaceObject: false,
          extension: false,
          fields: Set<fieldName>       // fields this graph can RETURN for this type (owned, shareable, provided)
        }
      },
      fields: {
        [fieldName]: {
          owners: Set<graphName>,      // graphs that resolve it (after @override applied)
          external: Set<graphName>,
          requires: { [graphName]: SelectionSet },
          provides: { [graphName]: SelectionSet },
          overrideFrom: string | null
        }
      }
    }
  }
}
```

Rules encoded in `plan-index.js`:
- no `@join__field` on a field ⇒ every graph in `@join__type` owns it (shareable-by-all case);
- `@join__field(graph:G, external:true)` ⇒ G is not an owner;
- `@join__field(graph:G, override:"H")` ⇒ owner is G only;
- `@join__field(graph:G, provides:"a b")` ⇒ when the field's value came from G, child fields `a b` are readable from
  the parent payload (no extra hop);
- `@join__type(graph:G, key:K, resolvable:false)` ⇒ never send `_entities` for T to G.

## 4. Query planner: plan-then-execute (layer 3)

### 4.1 Integration point with mercurius

Mercurius owns parse/validate/execute (graphql-js). We do not replace `execute`; we plan and execute the whole
operation **before** graphql-js runs and let graphql-js shape the response from the plan result:

```
preExecution hook (gateway)                       root field resolvers (Query/Mutation)
  plan   = planCache.get(doc, opName) ?? buildQueryPlan(doc, planIndex)
  result = await executePlan(plan, { variables, context })      →   return context[kPlanResult].data[field]
  context[kPlanResult] = result; errors → addErrorsToContext
```

- Non-root object fields get the trivial parent-read resolver; graphql-js handles nullability, aliases, fragments,
  `@skip`/`@include` on the already-fetched data (fetch selections are built from the same document, so unused
  branches are not fetched).
- Subscriptions: the root `subscribe` stays a single-service subscription (today's path); each event payload is then
  run through `executePlan` for the entity follow-ups. Phase 7.
- `preGatewayExecution` fires once per Fetch node (service + document), same signature as today.
- Collectors (`collectHeaders` etc.) attach per Fetch node, keyed by the node's path.

### 4.2 Plan nodes

```js
// lib/planner/nodes.js
Sequence  { kind:'Sequence', nodes:[Node] }
Parallel  { kind:'Parallel', nodes:[Node] }
Fetch     { kind:'Fetch', graph, operationKind:'query'|'mutation', document, variableUsages:[name],
            requires: SelectionSet|null,     // for entity fetches: key + @requires fields to pull from the partial result
            entityType: string|null,         // typename for `_entities`; null for root fetches
            path: [string|'@'] }             // where results merge; '@' = list wildcard (Flatten semantics)
Condition { kind:'Condition', variable, ifNode, elseNode }   // @skip/@include on a whole branch (optional, later)
```

### 4.3 Builder (`lib/planner/build-query-plan.js`)

Input: validated `DocumentNode`, `operationName`, `PlanIndex`, gateway schema. Output: a `Sequence`.

1. Inline fragment spreads; expand abstract-type selections into per-concrete-type selections using the gateway
   schema (interfaces/unions live in the supergraph with `join__implements` / `join__unionMember`).
2. Walk the selection tree carrying `(typeName, currentGraph, path)`:
   - a field whose `owners` contains `currentGraph` stays in the current Fetch (prefer no hop);
   - otherwise open a new entity-fetch group for `(typeName, owner)` under `path`: `owner = pickOwner(...)`:
     `@override` winner > graph with a key satisfiable from `currentGraph`'s key set > any owner (then phase 6
     inserts a key-bridge hop);
   - `@requires` adds the required selection to the *parent* fetch and to the entity representation;
   - `@provides(graph:G)` on the parent field marks the provided sub-selection as resolvable by G without a hop;
   - `@inaccessible` fields are absent from the gateway schema, so validation rejects them before planning;
   - `@interfaceObject` graphs are owners of the interface's fields for every implementing type; representations sent
     to them use the interface name as `__typename`, and results are merged back by the concrete key.
3. Group consecutive fetches to the same graph at the same path into one `_entities` Fetch (one request per
   graph per hop; de-dupe representations by key).
4. Emit `Sequence` of hops; independent entity fetches at the same depth go in a `Parallel`.
5. Each Fetch's `document` is printed once at plan time with only the variables it uses. Root-fetch documents keep
   the original operation name + `Query_<field>` convention for hook compatibility.

### 4.4 Executor (`lib/planner/execute-plan.js`)

- Walks the plan: `Sequence` awaits in order, `Parallel` uses `Promise.all`.
- Root `Fetch` → `service.sendRequest`; entity `Fetch` → collect representations by walking `path` over the current
  result (`'@'` iterates arrays), build `{ __typename, ...key, ...requires }`, send one `_entities` request (batched
  per graph via `allowBatchedQueries` as today through `get-query-result.js`), merge each entity back by position.
- Errors: service errors get `path` rewritten to the gateway path and are pushed through `FederatedError` so
  `defaultErrorFormatter` stays unchanged. A failed entity fetch nulls the merged subtree, not the whole response.
- Stamps nothing on objects; ownership is static in the plan. `single-user-cache` is no longer needed for
  de-duplication (the plan already groups), but the per-request factory stays for hooks compatibility until phase 7.

### 4.5 Plan cache

`lib/planner/cache.js`: `tiny-lru` keyed by `${schemaVersion}:${operationName}:${hash(printedDocument)}` (replaces
`lruGatewayResolvers`). `schemaVersion` bumps on every successful `refresh()`. Same `gateway.cache` option.

### 4.6 Exposure / debugging

- `gateway.queryPlan: { expose: boolean | (context) => boolean }` → `extensions.queryPlan` (JSON of the plan tree)
  and request header `mercurius-query-plan: 1` for ad-hoc inspection. Default off.
- `app.graphqlGateway.buildQueryPlan(document, operationName)` public API for tests/tooling.
- `app.graphqlGateway.explain(query)` → printed plan (text), used by the test suite's snapshots.

## 5. Tooling, integration, migration

| Feature | Where | Why |
|---|---|---|
| `gateway.supergraphSdl: string \| () => Promise<string>` as an alternative to `services[]` + live composition | `lib/compose/index.js`, `build-gateway.js` | Run from a precomposed supergraph (Rover, Hive, Guild). PlanIndex reads `join__` directives, so any composer works. Also enables static schema at boot without hitting subgraphs. |
| `app.graphqlGateway.supergraphSdl`, `.publicSdl`, `.planIndex` | `build-gateway.js` | Feed Rover/Router/Hive, schema registries, CI schema checks. |
| `onGatewayReplaceSchema` hook gets `{ schema, supergraphSdl }` | `handlers.js`, `index.d.ts` | Publish composed SDL on refresh. |
| `gateway.composition.onError(errors)` / structured `MER_ERR_GQL_GATEWAY_COMPOSITION` with `extensions.code` per Guild rule (e.g. `INVALID_FIELD_SHARING`) | `lib/compose/errors.js` | Actionable errors; same codes as Apollo. |
| `upgradeSubgraphSdl(sdl, { version: '2.3' })` exported from `@mercuriusjs/federation` | `lib/upgrade.js` | Mechanical v1→v2 migration: adds `extend schema @link(...)`, converts `extend type X @key` to `type X @key` + `@external` retained, adds `@shareable` to value types defined in >1 subgraph (needs all SDLs: `upgradeSubgraphSdls(map)`). Also a bin: `npx @mercuriusjs/federation upgrade schema.graphql`. |
| Federation version auto-detect + `federation.version` override; warn once per subgraph when a v1 SDL is composed | `service-map.js` | Zero-config migration; visibility. |
| `gateway.queryPlan.expose` + `explain()` (§4.6) | planner | Debugging/parity testing. |
| `test/utils/plan-snapshot.js` | tests | Snapshot printed plans for every fixture query; diffs show planner regressions. |
| Apollo compat `implementations/mercurius-federation` + CI workflow | compat fork | Public conformance badge. |

## 6. Phases / sub-issues (file-level)

| # | Slice | Repo | Files | Est. |
|---|-------|------|-------|------|
| 1 | Subgraph: `@link` parse, versioned defs, naming/prefix, `_service.sdl` passthrough, repeatable `@key`, `@interfaceObject` in `_Entity` | federation | link.js, specs.js, naming.js, federation.js, tests | 4 d |
| 2 | Gateway: Guild composition, `PlanIndex`, executable schema from supergraph (strip `join__`, apply `@inaccessible`, keep custom directives), composition errors, `supergraphSdl` input/output | gateway | compose/*, build-gateway.js, service-map.js, errors.js | 5 d |
| 3 | Planner core: builder + executor + preExecution/root-resolver adapter + plan cache; single-graph ops and single-hop entity fetches with flat keys; first slice tests (`@link`, `@shareable`, `@override`, `@inaccessible`) | gateway | planner/*, build-gateway.js, test/fed2/* | 8–10 d |
| 4 | Keys: multiple `@key`, composite/nested keys, nested `@requires`, `@provides`, `resolvable:false` | gateway | planner/build-query-plan.js, field-set.js, tests | 4 d |
| 5 | Abstract types across graphs (interfaces, unions, `join__implements`), `@interfaceObject` | both | planner/*, federation.js, tests | 5 d |
| 6 | Multi-hop key bridging (owner has no key the current graph can satisfy) via path search over graphs×keys | gateway | planner/paths.js | 4 d |
| 7 | Parity: all 204 existing tests on the planner; hooks per Fetch, collectors, batching, subscriptions follow-ups, error paths; delete legacy resolver path | gateway | make-resolver.js (remove), handlers.js, collectors.js, test/* | 6 d |
| 8 | Conformance: compat fork implementation + CI; in-repo gateway conformance test with the suite's 3 schemas + queries; plan snapshots | compat fork, gateway | §2.3, test/conformance/* | 4 d |
| 9 | Migration tooling: `upgradeSubgraphSdl`, bin, v1 warnings, `queryPlan.expose`/`explain` | federation, gateway | lib/upgrade.js, planner/cache.js | 3 d |
| 10 | Docs, types, README migration guide, v6 changelogs, upstream PRs to mercurius-js | both | README.md, index.d.ts | 3 d |

Total ≈ 9–10 focused weeks. Phases 1 and 2 are independent and can run in parallel. 3 depends on 1+2. 4–7 depend on 3 and are sequential.
8 can start after 1 (subgraph suite) and after 5 (gateway side). 9 can start after 2.

## 7. Risks / known gaps

- **Guild composition drift from Apollo.** Their README states no public spec, possible divergence. Mitigation:
  pin exact version; conformance fixtures; keep `composeSupergraph` behind one module so it can be swapped.
- **Custom directives in the gateway schema.** Existing tests (`test/custom-directives.js`) expect subgraph-defined
  directives to survive into the gateway schema. `publicSdl` may drop them; `schema-from-supergraph.js` must
  rebuild from `supergraphDocumentNode` (strip `join__`/`link__`, keep the rest) rather than from `publicSdl`.
- **Behavioural deltas on the v1 path when composed by Guild** (e.g. value types with mismatched fields now error
  where mercurius silently merged). Phase 8 quantifies this; it decides whether v2 composition becomes default in a
  major bump or stays opt-in.
- **Subscriptions** are untouched by Fed 2 directives; keep them on the existing path and add one regression test.
- **No Docker in this cloud session.** The Apollo suite run happens in the compat fork's CI or locally.
- **`@requires` as extension marker** (`util.js`) is wrong for Fed 2 and must only apply in v1 mode.

## 8. Decisions log

| Q | Decision |
|---|---|
| Composition library | Adopt `@theguild/federation-composition`, pinned exact version. |
| Delivery | New majors (gateway 6, federation 6), v2 default, v1 subgraphs auto-detected. |
| First slice | `@link`, `@shareable`, `@override`, `@inaccessible`. |
| Execution model | Plan-then-execute planner (§4); legacy resolver path deleted in phase 7. |
| Repos | Fork `mercurius-js/mercurius-federation` and `apollographql/apollo-federation-subgraph-compatibility` under `dwelch2344`. |
| Tooling | Everything in §5 is in scope. |
