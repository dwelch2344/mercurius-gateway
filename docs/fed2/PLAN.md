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

**Decision proposed:** use `@theguild/federation-composition` for composition + validation (layer 2) and build the
gateway's ownership index from its supergraph output. That turns "largest and riskiest" into "medium", keeps MIT,
and makes layer 3 (planning) the real work. Hand-rolling Fed 2 composition is the fallback only if the Guild lib
proves incompatible in practice.

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
│   ├── build-gateway.js         MOD  compose via lib/compose; defineResolvers takes a PlanIndex instead of the two maps
│   ├── service-map.js           MOD  keep parsed DocumentNode + detected fed version per service; drop createTypeMap in v2 path
│   ├── make-resolver.js         MOD  swap ownership/selection/representation helpers for lib/planning/*
│   ├── find-value-types.js      KEEP (v1 path only; deleted when v1 composition is removed)
│   ├── get-query-result.js      KEEP
│   └── request.js               KEEP
├── compose/
│   ├── index.js                 NEW  composeSupergraph(services) → { schema, planIndex, supergraphSdl, publicSdl }
│   ├── plan-index.js            NEW  buildPlanIndex(supergraphDocumentNode) → PlanIndex
│   ├── schema-from-supergraph.js NEW  executable GraphQLSchema: strip join__/link, apply @inaccessible, keep custom + composed directives
│   └── errors.js                NEW  MER_ERR_GQL_GATEWAY_COMPOSITION (wraps Guild GraphQLErrors; keeps `extensions.code`)
├── planning/
│   ├── owner.js                 NEW  pickOwner({ planIndex, typeName, fieldName, parentGraph }) → graphName
│   ├── selection.js             NEW  pruneSelectionForGraph(selections, graph, typeName, planIndex, schema) (replaces collectServiceTypeFields)
│   ├── representation.js        NEW  buildRepresentation(obj, typeName, graph, planIndex) — picks a satisfiable key, supports nested keys
│   ├── requires.js              NEW  collectRequires(field, graph) → selection set; ensure parent fetch includes it
│   └── field-set.js             NEW  parseFieldSet('sku variation { id }') → SelectionSet; satisfiedBy(obj, selectionSet)
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

## 4. Resolver model with the PlanIndex (layer 3)

`defineResolvers` loop, per `(type, field)`:

```
owners = index.types[T].fields[f].owners
if Query/Mutation/Subscription root      → makeResolver(query op, owner = single owner)
elif owners is empty (introspection etc) → read from parent
else:
  resolver = (parent, args, ctx, info) =>
    g = pickOwner({ parentGraph: parent[kGraph], owners, T })   // prefer the graph the parent came from
    if parent has f and g == parentGraph                        → return parent[f]
    rep = buildRepresentation(parent, T, g, index)              // choose a key g accepts that parent satisfies
    if rep == null                                              → multi-hop: fetch missing key via a graph that has it (phase 4), else error
    reqs = collectRequires(T, f, g)                             // merge required fields into rep (nested OK)
    return entityLoader(g).load({ T, rep ∪ reqs, selection: prune(info, g, T) })
```

Two mechanics that make this work and are new:
- **Tag payloads with origin graph.** `makeResolver` stamps `Symbol(kGraph)` on objects returned by a service so
  children know which graph the parent came from (today the code infers this from the static map).
- **Selection pruning uses `index.types[T].graphs[g].fields`** and recurses through nested object types using the
  same index, adding every key field-set that `g` accepts for `T` (not only the first `@key`) so a later hop can
  build a representation.

Entity batching stays on `single-user-cache` keyed by `${graph}Entity`; `get-query-result.js` unchanged.

## 5. Phases / sub-issues (file-level)

| # | Slice | Repo | Files | Est. |
|---|-------|------|-------|------|
| 1 | Subgraph: `@link` parse, versioned defs, naming, `_service.sdl` passthrough, repeatable `@key` | federation | link.js, specs.js, naming.js, federation.js, tests | 3–4 d |
| 2 | Gateway: adopt Guild composition behind `gateway.federation.version` flag; PlanIndex; executable schema from supergraph; composition error mapping. v1 path untouched. | gateway | compose/*, build-gateway.js, service-map.js, errors.js | 4–5 d |
| 3 | First slice end-to-end: `@link` + `@shareable` (value types and shared entity fields) | gateway | planning/owner.js, selection.js, make-resolver.js, test/fed2/link-shareable.js | 3 d |
| 4 | `@override`, `@inaccessible`, `@tag` (metadata only), `@composeDirective` passthrough | gateway | planning/owner.js, schema-from-supergraph.js, tests | 2 d |
| 5 | Keys: multiple `@key`, composite/nested keys, nested `@requires`, `@provides` | gateway | planning/representation.js, requires.js, field-set.js, tests | 4 d |
| 6 | `@interfaceObject` + interface `@key` | both | federation.js (_Entity), planning/*, test | 3 d |
| 7 | Multi-hop entity jumps (parent lacks any key the owner accepts) | gateway | planning/owner.js (path search over graphs×keys), make-resolver.js | 4–5 d |
| 8 | Run all 204 existing tests through the v2 composition path (mixed v1/v2); decide default + major bump | gateway | CI matrix `FED_COMPOSITION=v1|v2` | 2 d |
| 9 | Conformance: `implementations/mercurius-federation` in Apollo suite + in-repo gateway conformance test | compat fork, gateway | see §2.3, test/conformance/* | 3 d |
| 10 | Docs, types, README migration guide, upstream PRs to mercurius-js | both | README.md, index.d.ts | 2 d |

Phases 1 and 2 are independent and can run in parallel. 3 depends on 1+2. 5–7 depend on 3. 9 can start after 1
(subgraph suite) and after 5 (gateway side).

## 6. Risks / known gaps

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

## 7. Open questions (answers change the plan)

1. Adopt `@theguild/federation-composition` (recommended) or hand-write Fed 2 composition?
2. Delivery: new major (`@mercuriusjs/gateway` 6 / `@mercuriusjs/federation` 6) with v2 default and v1 kept behind
   a flag, or opt-in flag in a minor first?
3. First slice scope: `@link` + `@shareable` only (issue text) or fold in `@override` + `@inaccessible` since the
   PlanIndex gives them almost for free?
4. Planner ambition: keep the resolver-per-field model (this plan) vs. a real plan-then-execute planner. The latter
   is a rewrite of `make-resolver.js` and the "couple of months" estimate.
5. Fork `mercurius-js/mercurius-federation` under `dwelch2344` and attach it to the session now?
6. Should the gateway also expose `supergraphSdl` (e.g. `app.graphqlGateway.supergraphSdl`) for Rover/Router
   tooling? Cheap once composed.
