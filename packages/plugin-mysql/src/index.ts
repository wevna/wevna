// @wevna/plugin-mysql: captures MySQL / MariaDB queries made through mysql2's
// promise API, as sql.query events correlated to the request that ran them.
export { createMysqlPlugin, type MysqlPlugin, type MysqlQueryable } from "./mysql-plugin.js";
