export { ToolRegistry } from './registry.js';
export { decideAutonomy } from './autonomy.js';
export {
  hasAllRequiredPermissions,
  matchesPermission,
} from './rbac.js';
export type {
  ExecutionContext,
  ToolExecutionResponse,
  ToolHandler,
  HandlerMap,
} from './types.js';

export {
  buildCurrentHvacReport,
  buildHvacSnapshotFromDetail,
  loadApplicableHvacReferencesForSession,
  loadHvacDiagnosticSessionDetail,
  lookupHvacOemReferences,
} from './hvac-diagnostics.js';
