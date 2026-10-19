import { FastifyInstance, FastifyReply } from 'fastify'
import { MercuriusContext, MercuriusPlugin, MercuriusOptions, PreExecutionHookResponse } from 'mercurius'
import { IncomingHttpHeaders, OutgoingHttpHeaders } from "http"

import {
  DocumentNode,
  GraphQLSchema,
  ExecutionResult,
} from "graphql";
import { Dispatcher } from "undici";

interface ServiceConfig {
  setSchema: (schema: string) => ServiceConfig;
}

/**
 * A query plan: the tree of subgraph fetches executed for one operation.
 */
export interface QueryPlanFetchNode {
  id: number;
  graph: string;
  operation: 'query' | 'mutation' | 'subscription';
  /** `null` for a root fetch, the entity type name for an `_entities` fetch */
  entityType: string | null;
  /** response path of the parent objects; `@` descends into lists */
  path: string[];
  /** root fetches: the response keys this fetch provides */
  responseKeys: string[];
  variableNames: Set<string>;
  documentNode: DocumentNode;
  document: string;
  children: QueryPlanFetchNode[];
}

export interface QueryPlan {
  operation: 'query' | 'mutation' | 'subscription';
  operationName: string | null;
  /** true for mutations: root fetches run one after another */
  ordered: boolean;
  roots: QueryPlanFetchNode[];
}

/**
 * Per-field / per-type ownership derived from the supergraph `join__` directives.
 */
export interface PlanIndexField {
  name: string;
  owners: Set<string>;
  external: Set<string>;
  requires: Record<string, { fields: string }>;
  provides: Record<string, { fields: string }>;
  overrideFrom: string | null;
  overridingGraph: string | null;
  viaInterfaceObject: boolean;
  inaccessible: boolean;
  arguments: string[];
}

export interface PlanIndexType {
  name: string;
  kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  graphs: Record<string, { keys: Array<{ fields: string; resolvable: boolean }>; resolvable: boolean; isInterfaceObject: boolean; extension: boolean }>;
  interfaces: string[];
  fields: Record<string, PlanIndexField>;
  inaccessible: boolean;
}

export interface PlanIndex {
  graphs: Record<string, { name: string; enumValue: string; url: string }>;
  graphByEnum: Record<string, string>;
  types: Record<string, PlanIndexType>;
}

interface Gateway {
  refresh: (isRetry?: boolean) => Promise<GraphQLSchema | null>;
  serviceMap: Record<string, ServiceConfig>;
  /** the executable API schema */
  schema: GraphQLSchema;
  /** the composed supergraph (join spec), consumable by Rover, Router, Hive and this gateway's `supergraphSdl` option */
  supergraphSdl: string;
  /** the API schema SDL (no federation machinery, no @inaccessible elements) */
  publicSdl: string;
  planIndex: PlanIndex;
  /** federation version detected per subgraph (1 or 2); empty when running from a precomposed supergraph */
  federationVersions: Record<string, 1 | 2>;
  /** build the query plan for an operation (validated against the API schema) */
  buildQueryPlan: (source: string | DocumentNode, operationName?: string) => QueryPlan;
  /** human-readable query plan */
  explain: (source: string | DocumentNode, operationName?: string) => string;

  /**
   * `preGatewayExecution` is the hook to be executed in the GraphQL gateway request lifecycle.
   * The previous hook was `preExecution`, the next hook will be `onResolution`.
   * Notice: in the `preGatewayExecution` hook, you can modify the following items by returning them in the hook definition:
   *  - `document`
   *  - `errors`
   * Each hook definition will trigger multiple times in a single request just before executing remote GraphQL queries on the federated services.
   */
  addHook<TContext = MercuriusContext, TError extends Error = Error>(name: 'preGatewayExecution', hook: preGatewayExecutionHookHandler<TContext, TError>): void;

  /**
   * `preGatewaySubscriptionExecution` is the hook to be executed in the GraphQL gateway subscription lifecycle.
   * The previous hook was `preSubscriptionExecution`, the next hook will be `onSubscriptionResolution`.
   */
  addHook<TContext = MercuriusContext>(name: 'preGatewaySubscriptionExecution', hook: preGatewaySubscriptionExecutionHookHandler<TContext>): void;

  /**
   * `onGatewayReplaceSchema` is an application lifecycle hook. When the Gateway service obtains new versions of federated schemas within a defined polling interval, the `onGatewayReplaceSchema` hook will be triggered every time a new schema is built. It is called just before the old schema is replaced with the new one.
   * This hook will only be triggered in gateway mode. It has the following parameters:
   *  - `instance` - The gateway server `FastifyInstance` (this contains the old schema).
   *  - `schema` - The new schema that has been built from the gateway refresh.
   */
  addHook(name: 'onGatewayReplaceSchema', hook: onGatewayReplaceSchemaHookHandler): void;
}

declare module "fastify" {
  interface FastifyInstance {
    /**
     * GraphQL plugin
     */
    graphqlGateway: Gateway
  }

  interface FastifyReply {
    /**
     * @param source GraphQL query string
     * @param context request context
     * @param variables request variables which will get passed to the executor
     * @param operationName specify which operation will be run
     */
    graphql<
      TData extends Record<string, any> = Record<string, any>,
      TVariables extends Record<string, any> = Record<string, any>
      >(
      source: string,
      context?: Record<string, any>,
      variables?: TVariables,
      operationName?: string
    ): Promise<ExecutionResult<TData>>;
  }
}

/**
 * Federated GraphQL Service metadata
 */
export interface MercuriusServiceMetadata {
  name: string;
}

export interface Collectors {
  collectHeaders?: boolean;
  collectStatutsCodes?: boolean;
  collectExtensions?: boolean;
}

interface WsConnectionParams {
  connectionInitPayload?:
    | (() => Record<string, any> | Promise<Record<string, any>>)
    | Record<string, any>;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  connectionCallback?: () => void;
  failedConnectionCallback?: (err: { message: string }) => void | Promise<void>;
  failedReconnectCallback?: () => void;
  rewriteConnectionInitPayload?: <TContext extends MercuriusContext = MercuriusContext>(payload: Record<string, any> | undefined, context: TContext) => Record<string, any>;
}

export interface MercuriusGatewayService {
  name: string;
  url: string | string[];
  schema?: string;
  wsUrl?: string;
  mandatory?: boolean;
  agent?: Dispatcher;
  initHeaders?:
    | (() => OutgoingHttpHeaders | Promise<OutgoingHttpHeaders>)
    | OutgoingHttpHeaders;
  rewriteHeaders?: <TContext extends MercuriusContext = MercuriusContext>(
    headers: IncomingHttpHeaders,
    context: TContext
  ) => OutgoingHttpHeaders | Promise<OutgoingHttpHeaders>;
  connections?: number;
  bodyTimeout?: number;
  headersTimeout?: number;
  maxHeaderSize?: number;
  keepAlive?: number;
  keepAliveMaxTimeout?: number;
  rejectUnauthorized?: boolean;
  wsConnectionParams?:
    | (() => WsConnectionParams | Promise<WsConnectionParams>)
    | WsConnectionParams;
  setResponseHeaders?: (reply: FastifyReply) => void;
  collectors?: Collectors;
  allowBatchedQueries?: boolean;
}

export interface MercuriusGatewayOptions {
  gateway: {
    services: Array<MercuriusGatewayService> | (() => Promise<Array<MercuriusGatewayService>>);
    /**
     * A precomposed supergraph SDL (join spec, e.g. from Rover, Hive or this gateway's `supergraphSdl`).
     * When set the gateway runs from it instead of composing the subgraph SDLs; `services` still provide the endpoints.
     */
    supergraphSdl?: string | (() => string | Promise<string>);
    pollingInterval?: number;
    errorHandler?(error: Error, service: MercuriusGatewayService): void;
    retryServicesCount?: number;
    retryServicesInterval?: number;
  };
}

type MercuriusFederationOptions = MercuriusOptions & MercuriusGatewayOptions

declare const mercuriusGatewayPlugin: (
  instance: FastifyInstance,
  opts: MercuriusFederationOptions
) => void

export default mercuriusGatewayPlugin;

// ------------------------
// Request Lifecycle hooks
// ------------------------

/**
 * `preGatewayExecution` is the hook to be executed in the GraphQL gateway request lifecycle.
 * The previous hook was `preExecution`, the next hook will be `onResolution`.
 * Notice: in the `preGatewayExecution` hook, you can modify the following items by returning them in the hook definition:
 *  - `document`
 *  - `errors`
 * Each hook definition will trigger multiple times in a single request just before executing remote GraphQL queries on the federated services.
 *
 * Because it is a gateway hook, this hook contains service metadata in the `service` parameter:
 *  - `name`: service name
 */
export interface preGatewayExecutionHookHandler<TContext = MercuriusContext, TError extends Error = Error> {
  (
    schema: GraphQLSchema,
    source: DocumentNode,
    context: TContext,
    service: MercuriusServiceMetadata
  ): Promise<PreExecutionHookResponse<TError> | void> | PreExecutionHookResponse<TError> | void;
}

// -----------------------------
// Subscription Lifecycle hooks
// -----------------------------

/**
 * `preGatewaySubscriptionExecution` is the hook to be executed in the GraphQL gateway subscription lifecycle.
 * The previous hook was `preSubscriptionExecution`, the next hook will be `onSubscriptionResolution`.
 *
 *  Because it is a gateway hook, this hook contains service metadata in the `service` parameter:
 *  - `name`: service name
 */
export interface preGatewaySubscriptionExecutionHookHandler<TContext = MercuriusContext> {
  (
    schema: GraphQLSchema,
    source: DocumentNode,
    context: TContext,
    service: MercuriusServiceMetadata
  ): Promise<void> | void;
}

// ----------------------------
// Application Lifecycle hooks
// ----------------------------

/**
 * `onGatewayReplaceSchema` is an application lifecycle hook. When the Gateway service obtains new versions of federated schemas within a defined polling interval, the `onGatewayReplaceSchema` hook will be triggered every time a new schema is built. It is called just before the old schema is replaced with the new one.
 * This hook will only be triggered in gateway mode. It has the following parameters:
 *  - `instance` - The gateway server `FastifyInstance` (this contains the old schema).
 *  - `schema` - The new schema that has been built from the gateway refresh.
 */
export interface onGatewayReplaceSchemaHookHandler {
  (
    instance: FastifyInstance,
    schema: GraphQLSchema
  ): Promise<void> | void;
}
