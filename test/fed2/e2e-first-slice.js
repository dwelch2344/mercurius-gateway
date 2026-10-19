'use strict'

const { test } = require('node:test')
const Fastify = require('fastify')
const plugin = require('../../index')
const { createFed2Service } = require('../utils/create-fed2-service')

const LINK = 'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@override", "@inaccessible", "@external", "@requires", "@provides"])'

const users = {
  u1: { id: 'u1', email: 'a@x.io', name: 'Alice', secret: 's3cret', yearsOfEmployment: 10, totalProductsCreated: 1337 },
  u2: { id: 'u2', email: 'b@x.io', name: 'Bob', secret: 'hush', yearsOfEmployment: 2, totalProductsCreated: 7 }
}
const posts = {
  p1: { id: 'p1', title: 'Hello', authorId: 'u1' },
  p2: { id: 'p2', title: 'World', authorId: 'u2' },
  p3: { id: 'p3', title: 'Again', authorId: 'u1' }
}

async function usersService (t) {
  return createFed2Service(t, `
    ${LINK}
    type Query { me: User users: [User!]! }
    type User @key(fields: "id") {
      id: ID!
      email: String
      name: String
      secret: String @inaccessible
      yearsOfEmployment: Int
      totalProductsCreated: Int
    }
    type PageInfo @shareable { hasNextPage: Boolean! }
  `, {
    Query: { me: () => users.u1, users: () => Object.values(users) },
    User: { __resolveReference: ref => users[ref.id] }
  })
}

async function postsService (t, opts) {
  return createFed2Service(t, `
    ${LINK}
    type Query { posts: [Post!]! }
    type Post @key(fields: "id") {
      id: ID!
      title: String
      author: User @provides(fields: "email")
    }
    type User @key(fields: "id") {
      id: ID!
      email: String @external
      totalProductsCreated: Int @external
      yearsOfEmployment: Int @external
      name: String @override(from: "users")
      posts: [Post!]!
      pageInfo: PageInfo
      avg: Int @requires(fields: "totalProductsCreated yearsOfEmployment")
    }
    type PageInfo @shareable { hasNextPage: Boolean! }
  `, {
    Query: { posts: () => Object.values(posts) },
    Post: {
      __resolveReference: ref => posts[ref.id],
      author: post => ({ __typename: 'User', id: post.authorId, email: users[post.authorId].email })
    },
    User: {
      __resolveReference: ref => ({ ...ref }),
      name: user => `${users[user.id].name} (posts)`,
      posts: user => Object.values(posts).filter(p => p.authorId === user.id),
      pageInfo: () => ({ hasNextPage: false }),
      avg: user => Math.round(user.totalProductsCreated / user.yearsOfEmployment)
    }
  }, opts)
}

async function createGateway (t, services, extra = {}) {
  const gateway = Fastify()
  t.after(() => gateway.close())
  await gateway.register(plugin, { gateway: { services, ...extra } })
  await gateway.ready()
  return gateway
}

async function query (gateway, source, variables) {
  const res = await gateway.inject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    url: '/graphql',
    body: JSON.stringify({ query: source, variables })
  })
  return JSON.parse(res.body)
}

test('@link + @shareable: value types and entity fields compose and resolve across two federation 2 subgraphs', async t => {
  const u = await usersService(t)
  const p = await postsService(t)
  const gateway = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }])

  t.assert.deepStrictEqual(gateway.graphqlGateway.federationVersions, { users: 2, posts: 2 })
  t.assert.match(gateway.graphqlGateway.supergraphSdl, /join__graph\(name: "posts"/)

  const result = await query(gateway, `{
    me { id email posts { id title author { id email } } pageInfo { hasNextPage } }
    posts { id author { email yearsOfEmployment } }
  }`)
  t.assert.deepStrictEqual(result, {
    data: {
      me: {
        id: 'u1',
        email: 'a@x.io',
        posts: [
          { id: 'p1', title: 'Hello', author: { id: 'u1', email: 'a@x.io' } },
          { id: 'p3', title: 'Again', author: { id: 'u1', email: 'a@x.io' } }
        ],
        pageInfo: { hasNextPage: false }
      },
      posts: [
        { id: 'p1', author: { email: 'a@x.io', yearsOfEmployment: 10 } },
        { id: 'p2', author: { email: 'b@x.io', yearsOfEmployment: 2 } },
        { id: 'p3', author: { email: 'a@x.io', yearsOfEmployment: 10 } }
      ]
    }
  })

  // posts.author.email is @provides'd by posts: users is only asked for yearsOfEmployment, once, batched
  const usersEntityRequests = u.requests.filter(r => r.query.includes('_entities'))
  t.assert.strictEqual(usersEntityRequests.length, 1)
  t.assert.deepStrictEqual(usersEntityRequests[0].variables.representations, [
    { __typename: 'User', id: 'u1' },
    { __typename: 'User', id: 'u2' }
  ])
  t.assert.match(usersEntityRequests[0].query, /yearsOfEmployment/)
  t.assert.doesNotMatch(usersEntityRequests[0].query, /email/)
})

test('@override: the overriding subgraph serves the field and the original owner is never asked for it', async t => {
  const u = await usersService(t)
  const p = await postsService(t)
  const gateway = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }])

  const result = await query(gateway, '{ me { id name } users { name } }')
  t.assert.deepStrictEqual(result, {
    data: {
      me: { id: 'u1', name: 'Alice (posts)' },
      users: [{ name: 'Alice (posts)' }, { name: 'Bob (posts)' }]
    }
  })
  for (const request of u.requests) {
    t.assert.doesNotMatch(request.query, /\bname\b/, 'users must not be asked for the overridden field')
  }
  t.assert.strictEqual(p.requests.filter(r => r.query.includes('_entities')).length, 2)
})

test('@inaccessible: hidden fields are absent from the API schema and rejected at validation', async t => {
  const u = await usersService(t)
  const p = await postsService(t)
  const gateway = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }])

  t.assert.strictEqual(gateway.graphql.schema.getType('User').getFields().secret, undefined)
  t.assert.doesNotMatch(gateway.graphqlGateway.publicSdl, /secret/)
  const result = await query(gateway, '{ me { id secret } }')
  t.assert.strictEqual(result.data, null)
  t.assert.match(result.errors[0].message, /Cannot query field "secret" on type "User"/)
})

test('@requires: required fields are collected from their owner before the requiring subgraph is called', async t => {
  const u = await usersService(t)
  const p = await postsService(t)
  const gateway = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }])

  const result = await query(gateway, '{ users { id avg } }')
  t.assert.deepStrictEqual(result, { data: { users: [{ id: 'u1', avg: 134 }, { id: 'u2', avg: 4 }] } })

  const postsEntity = p.requests.find(r => r.query.includes('_entities'))
  t.assert.deepStrictEqual(postsEntity.variables.representations, [
    { __typename: 'User', id: 'u1', totalProductsCreated: 1337, yearsOfEmployment: 10 },
    { __typename: 'User', id: 'u2', totalProductsCreated: 7, yearsOfEmployment: 2 }
  ])
})

test('composition errors surface at registration with the composition code', async t => {
  const u = await usersService(t)
  const other = await createFed2Service(t, `
    ${LINK}
    type Query { other: User }
    type User @key(fields: "id") { id: ID! email: String }
  `)
  const gateway = Fastify()
  t.after(() => gateway.close())
  await t.assert.rejects(
    async () => gateway.register(plugin, { gateway: { services: [{ name: 'users', url: u.url }, { name: 'other', url: other.url }] } }),
    err => err.code === 'MER_ERR_GQL_GATEWAY_COMPOSITION' && err.errors[0].extensions.code === 'INVALID_FIELD_SHARING' && /User.email/.test(err.message)
  )
})

test('explain() and buildQueryPlan() expose the plan', async t => {
  const u = await usersService(t)
  const p = await postsService(t)
  const gateway = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }])

  const plan = gateway.graphqlGateway.buildQueryPlan('{ me { id posts { id } } }')
  t.assert.strictEqual(plan.roots[0].graph, 'users')
  t.assert.strictEqual(plan.roots[0].children[0].graph, 'posts')
  const text = gateway.graphqlGateway.explain('{ me { id posts { id } } }')
  t.assert.match(text, /Fetch\(graph: users\)/)
  t.assert.match(text, /Flatten\(path: me\) Fetch\(graph: posts, type: User, key: "id"\)/)
  t.assert.throws(() => gateway.graphqlGateway.explain('{ nope }'), { code: 'MER_ERR_GQL_GATEWAY_PLANNING' })
})

test('a precomposed supergraphSdl drives the gateway; services are only used as endpoints', async t => {
  const u = await usersService(t)
  const p = await postsService(t)
  const composed = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }])
  const supergraphSdl = composed.graphqlGateway.supergraphSdl
  u.requests.length = 0
  p.requests.length = 0

  const gateway = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }], { supergraphSdl })
  t.assert.strictEqual(gateway.graphqlGateway.supergraphSdl, supergraphSdl)
  t.assert.deepStrictEqual(await query(gateway, '{ me { id name } }'), { data: { me: { id: 'u1', name: 'Alice (posts)' } } })

  // the supergraph must name only configured services
  const bad = Fastify()
  t.after(() => bad.close())
  await t.assert.rejects(
    async () => bad.register(plugin, { gateway: { services: [{ name: 'users', url: u.url }], supergraphSdl } }),
    { code: 'MER_ERR_GQL_GATEWAY_INIT', message: /subgraph "posts"/ }
  )
})

test('allowBatchedQueries: sibling entity fetches to one subgraph travel in a single batched request', async t => {
  const u = await usersService(t)
  const p = await postsService(t, { allowBatchedQueries: true })
  const gateway = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url, allowBatchedQueries: true }])

  const result = await query(gateway, '{ me { id posts { id } } users { id pageInfo { hasNextPage } } }')
  t.assert.deepStrictEqual(result, {
    data: {
      me: { id: 'u1', posts: [{ id: 'p1' }, { id: 'p3' }] },
      users: [{ id: 'u1', pageInfo: { hasNextPage: false } }, { id: 'u2', pageInfo: { hasNextPage: false } }]
    }
  })
  const batched = p.requests.filter(Array.isArray)
  t.assert.strictEqual(batched.length, 1)
  t.assert.strictEqual(batched[0].length, 2)
  t.assert.deepStrictEqual(batched[0].map(op => op.variables.representations.length), [1, 2])
  t.assert.strictEqual(p.requests.filter(r => !Array.isArray(r) && r.query.includes('_entities')).length, 0)
})

test('queryPlan.expose adds extensions.queryPlan to the response', async t => {
  const u = await usersService(t)
  const p = await postsService(t)
  const gateway = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }], {
    queryPlan: { expose: context => context.reply.request.headers['x-query-plan'] === '1' }
  })

  const res = await gateway.inject({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-query-plan': '1' },
    url: '/graphql',
    body: JSON.stringify({ query: 'query Q { me { id posts { id } } }' })
  })
  const body = JSON.parse(res.body)
  t.assert.deepStrictEqual(body.data, { me: { id: 'u1', posts: [{ id: 'p1' }, { id: 'p3' }] } })
  t.assert.strictEqual(body.extensions.queryPlan.operationName, 'Q')
  t.assert.deepStrictEqual(body.extensions.queryPlan.roots.map(r => r.graph), ['users'])
  t.assert.deepStrictEqual(body.extensions.queryPlan.roots[0].children[0].path, ['me'])
  t.assert.match(body.extensions.queryPlan.roots[0].children[0].document, /_entities/)

  const plain = await query(gateway, '{ me { id } }')
  t.assert.strictEqual(plain.extensions, undefined)

  const always = await createGateway(t, [{ name: 'users', url: u.url }, { name: 'posts', url: p.url }], { queryPlan: { expose: true } })
  t.assert.ok((await query(always, '{ me { id } }')).extensions.queryPlan)

  const bad = Fastify()
  t.after(() => bad.close())
  await t.assert.rejects(async () => bad.register(plugin, { gateway: { services: [{ name: 'users', url: u.url }], queryPlan: { expose: 'yes' } } }), { code: 'MER_ERR_INVALID_OPTS' })
})

test('a Federation 1 subgraph is reported once in the logs', async t => {
  const legacy = await createFed2Service(t, 'extend type Query { legacy: Int } type Thing @key(fields: "id") { id: ID! }', { Query: { legacy: () => 1 } })
  const u = await usersService(t)
  const warnings = []
  const gateway = Fastify({ logger: { level: 'warn', stream: { write: line => warnings.push(JSON.parse(line)) } } })
  t.after(() => gateway.close())
  await gateway.register(plugin, { gateway: { services: [{ name: 'users', url: u.url }, { name: 'legacy', url: legacy.url }] } })
  await gateway.graphqlGateway.refresh()
  const fed1 = warnings.filter(w => /Federation 1/.test(w.msg))
  t.assert.strictEqual(fed1.length, 1)
  t.assert.match(fed1[0].msg, /Subgraph "legacy" uses Federation 1/)
  t.assert.deepStrictEqual(gateway.graphqlGateway.federationVersions, { users: 2, legacy: 1 })
})
