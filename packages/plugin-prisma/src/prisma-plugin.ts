import { performance } from "node:perf_hooks";
import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginSetupResult,
  type WevnaPlugin,
} from "@wevna/sdk";

interface QueryHookParams {
  model?: string;
  operation: string;
  // Accepted and passed through, never read: args are where where-clauses and
  // written values live.
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

// The one piece of Prisma Client this needs. Structural, so this package does
// not depend on @prisma/client (whose generated types differ per project).
export interface PrismaClientLike {
  $extends(extension: {
    name?: string;
    query: { $allOperations: (params: QueryHookParams) => Promise<unknown> };
  }): unknown;
}

export interface PrismaPlugin extends WevnaPlugin {
  // Returns the extended client, typed as the client you passed in. Prisma
  // client extensions return a *new* client rather than modifying the old
  // one, so use the return value from here on:
  //
  //   const prisma = wevnaPrisma.extend(new PrismaClient());
  extend<T extends PrismaClientLike>(client: T): T;
}

// Prisma instrumentation through a client extension — Prisma's supported
// hook for observing every operation, with no monkey-patching and no
// dependence on the `query` log level being configured.
//
// Records the model and operation (`User.findMany`) and how long it took.
// This is deliberately the *operation* rather than the SQL Prisma generates:
// "findMany on User ran 40 times in one request" is the N+1 an application
// developer can act on, where the SQL beneath it is Prisma's business.
// Arguments are never read, for the same reason SQL parameters and MongoDB
// filters are not.
export function createPrismaPlugin(): PrismaPlugin {
  // Undefined before setup() and after teardown. extend() is legitimately
  // called before Wevna has started, so an operation with no context simply
  // publishes nothing — the application's query must never fail because
  // Wevna was not listening.
  let context: PluginContext | undefined;

  return {
    name: "@wevna/plugin-prisma",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    eventKinds: ["prisma.query"],

    setup(ctx: PluginContext): PluginSetupResult {
      context = ctx;
      return () => {
        context = undefined;
      };
    },

    extend<T extends PrismaClientLike>(client: T): T {
      return client.$extends({
        name: "wevna",
        query: {
          $allOperations: async ({ model, operation, args, query }) => {
            const startedAt = performance.now();
            try {
              const result = await query(args);
              context?.publish({
                kind: "prisma.query",
                attributes: {
                  operation,
                  ...(model ? { target: model } : {}),
                  durationMs: performance.now() - startedAt,
                },
              });
              return result;
            } catch (error) {
              context?.publish({
                kind: "prisma.query",
                attributes: {
                  operation,
                  ...(model ? { target: model } : {}),
                  durationMs: performance.now() - startedAt,
                  error: describeFailure(error),
                },
              });
              throw error;
            }
          },
        },
      }) as T;
    },
  };
}

// PrismaClientKnownRequestError carries a stable `code` (P2002, ...). Its
// message can quote the offending values, so the code is preferred.
function describeFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === "string") {
      return code;
    }
    if (typeof name === "string") {
      return name;
    }
  }
  return "QueryFailed";
}
