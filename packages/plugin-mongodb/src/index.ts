// @wevna/plugin-mongodb: captures MongoDB commands through the driver's
// command monitoring, as mongodb.command events correlated to the request
// that issued them.
export {
  createMongoDbPlugin,
  type MongoClientLike,
  type MongoCommandFinishedEvent,
  type MongoCommandStartedEvent,
  type MongoDbPlugin,
  type MongoDbPluginOptions,
} from "./mongodb-plugin.js";
