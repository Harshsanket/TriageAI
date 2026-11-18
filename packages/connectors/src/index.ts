export * from './types.js';
export * from './graphql.js';
export * from './sql.js';
export * from './oauth.js';

import type { ImportedGraphqlTool } from './graphql.js';
import type { ImportedSqlTool } from './sql.js';

/** Any tool descriptor produced by a generic connector importer. */
export type ImportedConnectorTool = ImportedGraphqlTool | ImportedSqlTool;
