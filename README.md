# @mercurius/gateway

A module to create an Apollo Federation gateway with `mercurius`. Subgraphs can speak
Federation 1 (`extend type` / `@extends`) or Federation 2 (`@link`, `@shareable`, `@override`,
`@inaccessible`, `@interfaceObject`, ...); the gateway composes them into a supergraph and
executes each operation through a query plan. See [Federation 2](#federation-2) and
[Migrating from v5](#migrating-from-v5).

## Quick start

```javascript
npm i fastify @mercuriusjs/federation @mercuriusjs/gateway
```

Create the `user` service
```js
'use strict'

const Fastify = require('fastify')
const { mercuriusFederationPlugin } = require('@mercuriusjs/federation')

const users = {
  1: {
    id: '1',
    name: 'John',
    username: '@john'
  },
  2: {
    id: '2',
    name: 'Jane',
    username: '@jane'
  }
}

const service = Fastify()
const schema = `
  extend type Query {
    me: User
  }

  type User @key(fields: "id") {
    id: ID!
    name: String
    username: String
  }
`

const resolvers = {
  Query: {
    me: () => {
      return users['1']
    }
  },
  User: {
    __resolveReference: (source, args, context, info) => {
      return users[source.id]
    }
  }
}

service.register(mercuriusFederationPlugin, {
  schema,
  resolvers
})

service.listen({ port: 4001 })
```

Create the `post` service
```js
'use strict'

const Fastify = require('fastify')
const { mercuriusFederationPlugin } = require('@mercuriusjs/federation')

const posts = {
  p1: {
    pid: 'p1',
    title: 'Post 1',
    content: 'Content 1',
    authorId: 'u1'
  },
  p2: {
    pid: 'p2',
    title: 'Post 2',
    content: 'Content 2',
    authorId: 'u2'
  }
}

const service = Fastify()
const schema = `
  extend type Query {
    topPosts(count: Int): [Post]
  }

  type Post @key(fields: "pid") {
    pid: ID!
    title: String
    content: String
    author: User @requires(fields: "pid title")
  }
`

const resolvers = {
  Query: {
    topPosts: (root, { count = 2 }) => Object.values(posts).slice(0, count)
  },
  Post: {
    __resolveReference: post => {
      return posts[post.pid]
    },
    author: post => {
      return {
        __typename: 'User',
        id: post.authorId
      }
    }
  }
}

service.register(mercuriusFederationPlugin, {
  schema,
  resolvers
})

service.listen({ port: 4002 })
```

Create the `gateway`
```js
'use strict'

const Fastify = require('fastify')
const mercuriusGateway = require('@mercuriusjs/gateway')

const gateway = Fastify()
gateway.register(mercuriusGateway, {
  gateway: {
    services: [
      {
        name: 'user',
        url: 'http://localhost:4001/graphql'
      },
      {
        name: 'post',
        url: 'http://localhost:4002/graphql'
      }
    ]
  }
})

gateway.listen({ port: 3000 })
```

## Federation 2

The gateway composes the subgraph SDLs with
[`@theguild/federation-composition`](https://github.com/the-guild-org/federation-composition)
(MIT, API-compatible with Apollo's composition) and derives everything it needs from the
resulting supergraph: the public API schema (with `@inaccessible` elements removed and
`@tag` metadata stripped) and a *plan index* describing which subgraph resolves which field,
with which `@key`s, `@requires`, `@provides` and `@override` rules.

Subgraphs are detected per SDL: an SDL with `extend schema @link(url: "https://specs.apollo.dev/federation/v2.x", ...)`
is Federation 2, anything else is Federation 1. Both can be mixed in one gateway. On the subgraph side use
`@mercuriusjs/federation` v6 (or any library that implements the subgraph specification).

```js
// users subgraph
const schema = `
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable"])

  type Query { me: User }
  type User @key(fields: "id") {
    id: ID!
    name: String @shareable
    email: String
  }
`

// posts subgraph
const schema = `
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@override", "@external", "@requires"])

  type Query { posts: [Post!]! }
  type Post @key(fields: "id") { id: ID! title: String author: User }
  type User @key(fields: "id") {
    id: ID!
    email: String @external
    name: String @override(from: "users")
    posts: [Post!]!
    initials: String @requires(fields: "email")
  }
`
```

Nothing changes on the gateway side: register the services as before.

### Query planning

Each operation is planned once (plans are cached per parsed document) and executed as a tree of
fetches: one root fetch per subgraph for the root fields it owns, then `_entities` fetches for the
fields other subgraphs resolve, keyed on a `@key` the current subgraph can supply. `@requires` fields
are gathered first, `@provides` fields are served inline, multiple keys, composite keys, nested value
types, interfaces, unions, `@interfaceObject` and multi-hop key translation are handled. Sibling
fetches to a subgraph configured with `allowBatchedQueries` share one request.

```js
console.log(app.graphqlGateway.explain('{ me { id posts { id } } }'))
// QueryPlan(query) {
//   Parallel {
//     Fetch(graph: users) {
//       query Query_me { me { id __typename } }
//       then {
//         Flatten(path: me) Fetch(graph: posts, type: User, key: "id") {
//           query EntitiesQuery($representations: [_Any!]!) { _entities(representations: $representations) { __typename ... on User { posts { id } } } }
//         }
//       }
//     }
//   }
// }
```

`app.graphqlGateway.buildQueryPlan(source, operationName)` returns the plan as an object, and
`gateway.queryPlan.expose` adds it to every response as `extensions.queryPlan`:

```js
app.register(mercuriusGateway, {
  gateway: {
    services,
    queryPlan: { expose: context => context.reply.request.headers['x-query-plan'] === '1' }
  }
})
```

### Running from a precomposed supergraph

Instead of composing at startup, hand the gateway a supergraph SDL produced by Rover, GraphQL Hive
or this gateway itself (`app.graphqlGateway.supergraphSdl`). The subgraph names in the supergraph
must match the configured `services`, which then only provide the endpoints.

```js
app.register(mercuriusGateway, {
  gateway: {
    services: [{ name: 'users', url: 'http://users:4001/graphql' }, { name: 'posts', url: 'http://posts:4002/graphql' }],
    supergraphSdl: () => fs.promises.readFile('./supergraph.graphql', 'utf8')
  }
})
```

A function is re-evaluated on every `pollingInterval` / `refresh()`.

### Composition errors

Invalid or conflicting subgraph SDLs fail at registration (or are logged on refresh) with
`MER_ERR_GQL_GATEWAY_COMPOSITION`. `err.errors` holds one `GraphQLError` per problem with the same
`extensions.code` Apollo uses (`INVALID_FIELD_SHARING`, `SATISFIABILITY_ERROR`,
`EXTERNAL_MISSING_ON_BASE`, ...).

Subgraphs that still speak Federation 1 are reported once in the logs; `@mercuriusjs/federation`
ships `upgradeSubgraphSdl()` / `mercurius-federation-upgrade` to convert them.

## API

### mercuriusGateway

Register the gateway in `fastify`.

```javascript
const mercuriusGateway = require('@mercurius/gateway')

const schema = ...
const resolvers = ...
const app = Fastify()

app.register(mercuriusGateway, {
  gateway: [
    services: [
      {
        name: 'user',
        url: 'http://localhost:4001/graphql'
      },
      {
        name: 'post',
        url: 'http://localhost:4002/graphql'
      }
    ]
  }
 
})
```

#### options
- all the mercurius plugin [options](https://mercurius.dev/#/docs/api/options?id=plugin-options)
- `gateway`: Object. Run the GraphQL server in gateway mode.

  - `gateway.services`: `Service[]` | `Function` An array of GraphQL services that are part of the gateway or a `Function` that returns a `Promise` that resolves to an array of services. **Required**.
    - `service.name`: A unique name for the service. Required.
    - `service.url`: The URL of the service endpoint. It can also be an `Array` of URLs and in which case all the requests will be load balanced throughout the URLs. Required.
    - `service.mandatory`: `Boolean` Marks service as mandatory. If any of the mandatory services are unavailable, gateway will exit with an error. (Default: `false`)
    - `service.useSecureParse`: `Boolean` Marks if the service response needs to be parsed securely using [secure-json-parse](https://github.com/fastify/secure-json-parse). (Default: `false`)
    - `service.rewriteHeaders`: `Function` A function that gets the original headers as a parameter and returns an object containing values that should be added to the headers
    - `service.setResponseHeaders`: `Function` A function that gets `reply` as a parameter and can be used to set headers for the federated response to be sent to the client.
    - `service.initHeaders`: `Function` or `Object` An object or a function that returns the headers sent to the service for the initial \_service SDL query.
    - `service.connections`: The number of clients to create. (Default: `10`)
    - `service.agent`: An optional, fully configured [undici](https://github.com/nodejs/undici) agent/pool instance to use to perform network requests. If used, you must set all connections options on the instance as the request related options from the `service` configuration will not be applied.
    - `service.bodyTimeout`: The timeout after which a request will time out, in milliseconds. (Default: `30e3` - 30 seconds)
    - `service.headersTimeout`: The amount of time the parser will wait to receive the complete HTTP headers, in milliseconds. (Default: `30e3` - 30 seconds)
    - `service.keepAliveMaxTimeout`: The maximum allowed keepAliveTimeout. (Default: `5e3` - 5 seconds)
    - `service.maxHeaderSize`: The maximum length of request headers in bytes. (Default: `16384` - 16KiB)
    - `service.keepAlive`: The amount of time pass between the keep-alive messages sent from the gateway to the service, if `undefined`, no keep-alive messages will be sent. (Default: `undefined`)
    - `service.wsUrl`: The url of the websocket endpoint
    - `service.wsConnectionParams`: `Function` or `Object`
      - `wsConnectionParams.connectionInitPayload`: `Function` or `Object` An object or a function that returns the `connection_init` payload sent to the service.
      - `wsConnectionParams.reconnect`: `Boolean` Enable reconnect on connection close (Default: `false`)
      - `wsConnectionParams.maxReconnectAttempts`: `Number` Defines the maximum reconnect attempts if reconnect is enabled (Default: `Infinity`)
      - `wsConnectionParams.connectionCallback`: `Function` A function called after a `connection_ack` message is received.
      - `wsConnectionParams.failedConnectionCallback`: `Function` A function called after a `connection_error` message is received, the first argument contains the message payload.
      - `wsConnectionParams.failedReconnectCallback`: `Function` A function called if reconnect is enabled and maxReconnectAttempts is reached.
      - `wsConnectionParams.rewriteConnectionInitPayload`: `Function` A function that gets the original `connection_init` payload along with the context as a parameter and returns an object that replaces the original `connection_init` payload before forwarding it to the federated service
    - `service.collectors`: `Object`
      - `collectors.collectHeaders`: `boolean` Adds to `context` the `collectors.responseHeaders` object in which are stored the response headers from federated services.
      - `collectors.collectStatutsCodes`: `boolean` Adds to `context` the `collectors.statusCodes` object in which are stored the status codes of the response from federated services.
       - `collectors.collectExtensions`: `boolean` Adds to `context` the `collectors.extensions` object in which are stored the extensions field of the response from federated services.
  - `gateway.retryServicesCount`: `Number` Specifies the maximum number of retries when a service fails to start on gateway initialization. (Default: 10)
  - `gateway.retryServicesInterval`: `Number` The amount of time(in milliseconds) between service retry attempts in case a service fails to start on gateway initialization. (Default: 3000)
  - `gateway.pollingInterval`: `Number` The amount of time (milliseconds) between polling the services for schema updates. If not specified, the gateway will not poll for schema updates. When `gateway.services` is a function, the list of services is updated with the result of the function every `gateway.pollingInterval` milliseconds.
  - `gateway.supergraphSdl`: `String` | `Function` A precomposed supergraph SDL (or a function returning one, possibly asynchronously) to run from instead of composing the service SDLs. See [Running from a precomposed supergraph](#running-from-a-precomposed-supergraph).
  - `gateway.queryPlan.expose`: `Boolean` | `Function` Add the query plan to the response as `extensions.queryPlan`, always or when the function (receiving the request context) returns `true`. (Default: `false`)
  - `gateway.cache`: `Boolean` | `Number` Query plan caching. `false` disables it; plans are otherwise cached per parsed document (the number is accepted for compatibility). (Default: `true`)

#### `fastify.graphqlGateway`

The plugin decorates the instance with the gateway:

- `schema`: the executable API schema (also `fastify.graphql.schema`).
- `supergraphSdl`: the composed supergraph SDL (join spec); feed it to Rover, Apollo Router, Hive or another gateway's `supergraphSdl` option.
- `publicSdl`: the API schema as SDL.
- `planIndex`: the ownership index derived from the supergraph (`types[name].fields[field].owners`, keys per subgraph, ...).
- `federationVersions`: `{ [serviceName]: 1 | 2 }` as detected from each SDL (empty when running from `supergraphSdl`).
- `buildQueryPlan(source, operationName?)` / `explain(source, operationName?)`: the query plan for an operation, as an object or as text.
- `refresh(isRetry?)`: re-fetch the service SDLs, recompose and replace the schema; resolves to the new schema or `null` when nothing changed.
- `serviceMap`: the configured services (`setSchema(sdl)` updates a service that was configured with a static `schema`).
- `addHook(name, fn)`: see [Hooks](#hooks).

## Hooks

Hooks are registered with the `fastify.graphqlGateway.addHook` method 
and allow you to listen to specific events in the GraphQL request/response lifecycle. 
You have to register a hook before the event is triggered, otherwise the event is lost.

By using hooks you can interact directly with the GraphQL lifecycle of Mercurius gateway. 
There are GraphQL Request and Subscription hooks:

- [GraphQL Request Hooks](#graphql-request-hooks)
  - [preGatewayExecution](#pregatewayexecution)
- [GraphQL Subscription Hooks](#graphql-subscription-hooks)
  - [preGatewaySubscriptionExecution](#pregatewaysubscriptionexecution)

**Notice:** these hooks are only supported with `async`/`await` or returning a `Promise`.

### Lifecycle

The schema of the internal lifecycle of Mercurius gateway.<br>

On the right branch of every section there is the next phase of the lifecycle, on the left branch there is the corresponding GraphQL error(s) that will be generated if the parent throws an error *(note that all the errors are automatically handled by Mercurius)*.

#### Gateway lifecycle

How the gateway lifecycle works integrated with the Mercurius lifecycle.

```
Incoming GraphQL Request
  │
  └─▶ Routing
           │
  errors ◀─┴─▶ preParsing Hook
                  │
         errors ◀─┴─▶ Parsing
                        │
               errors ◀─┴─▶ preValidation Hook
                               │
                      errors ◀─┴─▶ Validation
                                     │
                            errors ◀─┴─▶ preExecution Hook
                                            │
                                   errors ◀─┴─▶ Execution
                                                  │
                                                  └─▶ preGatewayExecution Hook(s) (appends errors only)
                                                         │
                                                errors ◀─┴─▶ GatewayExecution(s)
                                                               │
                                                      errors ◀─┴─▶ Resolution (once all GatewayExecutions have finished)
                                                                     │
                                                                     └─▶ onResolution Hook
```

#### Gateway subscription lifecycle

How the gateway subscription lifecycle works integrated with the Mercurius lifecycle.
```
Incoming GraphQL Websocket subscription data
  │
  └─▶ Routing
           │
  errors ◀─┴─▶ preSubscriptionParsing Hook
                  │
         errors ◀─┴─▶ Subscription Parsing
                        │
               errors ◀─┴─▶ preSubscriptionExecution Hook
                              │
                     errors ◀─┴─▶ Subscription Execution
                                    │
                                    │
                                    └─▶ preGatewaySubscriptionExecution Hook(s)
                                            │
                                   errors ◀─┴─▶ Gateway Subscription Execution(s)
                                                  │
                                      wait for subscription data
                                                  │
                   subscription closed on error ◀─┴─▶ Subscription Resolution (when subscription data is received)
                                                        │
                                                        └─▶ onSubscriptionResolution Hook
                                                              │
                                              keeping processing until subscription ended
                                                              │
                               subscription closed on error ◀─┴─▶ Subscription End (when subscription stop is received)
                                                                    │
                                                                    └─▶ onSubscriptionEnd Hook
```

### GraphQL Request Hooks

It is pretty easy to understand where each hook is executed by looking at the lifecycle definition.<br>

#### preGatewayExecution

In the `preGatewayExecution` hook, you can modify the following items by returning them in the hook definition:
- `document`
- `errors`

This hook will only be triggered in gateway mode. When in gateway mode, each hook definition will trigger multiple times in a single request just before executing remote GraphQL queries on the federated services.

Note, this hook contains service metadata in the `service` parameter:
- `name`: service name

```js
fastify.graphqlGateway.addHook('preGatewayExecution', async (schema, document, context, service) => {
  const { modifiedDocument, errors } = await asyncMethod(document)

  return {
    document: modifiedDocument,
    errors
  }
})
```

#### Manage Errors from a request hook
If you get an error during the execution of your hook, you can just throw an error.
The `preGatewayExecution` hook, which will continue execution of the rest of the query and append the error to the errors array in the response.

```js
fastify.graphqlGateway.addHook('preGatewayExecution', async (schema, document, context, service) => {
  throw new Error('Some error')
})
```

#### Add errors to the GraphQL response from a hook

The `preGatewayExecution` hook support adding errors to the GraphQL response.

```js
fastify.graphqlGateway.addHook('preGatewayExecution', async (schema, document, context) => {
  return {
    errors: [new Error('foo')]
  }
})
```

Note, the original query will still execute. Adding the above will result in the following response:

```json
{
  "data": {
    "foo": "bar"
  },
  "errors": [
    {
      "message": "foo"
    }
  ]
}
```

### GraphQL Subscription Hooks

It is pretty easy to understand where each hook is executed by looking at the lifecycle definition.<br>

#### preGatewaySubscriptionExecution

This hook will only be triggered in gateway mode. When in gateway mode, each hook definition will trigger when creating a subscription with a federated service.

Note, this hook contains service metadata in the `service` parameter:
- `name`: service name

```js
fastify.graphqlGateway.addHook('preGatewaySubscriptionExecution', async (schema, document, context, service) => {
  await asyncMethod()
})
```

#### Manage Errors from a subscription hook

If you get an error during the execution of your subscription hook, you can just throw an error and Mercurius will send the appropriate errors to the user along the websocket.`

```js
fastify.graphqlGateway.addHook('preSubscriptionParsing', async (schema, source, context) => {
  throw new Error('Some error')
})
```

### GraphQL Application lifecycle Hooks

There is one hook that you can use in a GraphQL application.

#### onGatewayReplaceSchema

When the Gateway service obtains new versions of federated schemas within a defined polling interval, the `onGatewayReplaceSchema` hook will be triggered every time a new schema is built. It is called just before the old schema is replaced with the new one.

It has the following parameters:

- `instance` - The gateway server `FastifyInstance` (this contains the old schema; `instance.graphqlGateway.supergraphSdl` and `planIndex` already hold the new composition).
- `schema` - The new schema that has been built from the gateway refresh.

```js
fastify.graphqlGateway.addHook('onGatewayReplaceSchema', async (instance, schema) => {
  await someSchemaTraversalFn()
})
```

If this hook throws, the error will be caught and logged using the `FastifyInstance` logger. Subsequent `onGatewayReplaceSchema` hooks that are registered will not be run for this interval.

### Collectors

Collectors gather additional information about the response from the services that are part of the gateway and adds them to the `context.collectors` object.

Depending on the configuration it may have the following fields:

- `responseHeaders`
- `statusCodes`
- `extensions`

Each collector stores data in the same format:
```json
  {
    "foo": { // query id
      "service": "bar", // name of the service
      "data": {
         "foo": "bar" // example: statusCode: 500
      }
    }
  }
```
It is possible to access and manipulate `context.collectors` via [onResolution Hook](https://github.com/mercurius-js/mercurius/blob/master/docs/hooks.md#onresolution)

```js
  app.graphql.addHook('onResolution', async function (execution, context) {
    console.log(context.collectors)

    // {
    //   statusCodes: {
    //     topPosts: {
    //       service: 'post',
    //       data: {
    //         statusCode: 500
    //       }
    //     },
    //     me: {
    //       service: 'user',
    //       data: {
    //         statusCode: 404
    //       }
    //     }
    //   },
    //   responseHeaders: {...},
    //   extensions: {...},
    // }

    execution.collectors = context.collectors // add collectors to response
  })
```
## Migrating from v5

v6 replaces the per-field resolvers of v5 with composition + query planning. Federation 1 subgraphs
keep working unchanged, but a few observable behaviours differ:

- **Composition is strict.** Subgraph SDLs that v5 merged silently now fail at startup with
  `MER_ERR_GQL_GATEWAY_COMPOSITION`: a field with different types or nullability across subgraphs
  (`name: String` vs `name: String!`), a `@key` on a field the subgraph does not declare, a field
  marked `@external` everywhere, a type extended with `@key` but defined without one, unsatisfiable
  queries. Fix the SDLs; the error lists every problem with its code.
- **Fewer requests.** All fields a subgraph resolves at one position travel in one request, and
  entity fetches to the same subgraph are batched per hop. Hooks such as `preGatewayExecution`
  therefore fire fewer times; `Query_<field>` and `EntitiesQuery` remain the operation names.
- **`@requires` is no longer exposed** as a directive of the gateway schema.
- **Empty reference lists** resolve to `[]` instead of `null`.
- **Null entities.** When a subgraph returns `null` for a representation, a bare reference (an
  object that only carried `__typename` and key fields) becomes `null` as before, while an object
  that already had data from its own subgraph keeps it and only the fields of that fetch become `null`.
- **Field order** in the API schema follows the supergraph rather than the first subgraph.
- **`gateway.cache`** now controls query plan caching; the size is ignored.
- Removed internals: `lib/gateway/make-resolver.js`, `find-value-types.js`, `get-query-result.js`,
  the per-service `typeMap` / `types` / `extensionTypeMap` properties and the `single-user-cache` dependency.

Subgraph migration to Federation 2 is optional and incremental: `@mercuriusjs/federation` provides
`upgradeSubgraphSdl()` and the `mercurius-federation-upgrade` command to add `@link` and `@shareable`
to a Federation 1 SDL.
