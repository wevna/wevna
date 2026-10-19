// @wevna/plugin-prisma: captures Prisma Client operations through a client
// extension, as prisma.query events correlated to the request that ran them.
export { createPrismaPlugin, type PrismaClientLike, type PrismaPlugin } from "./prisma-plugin.js";
