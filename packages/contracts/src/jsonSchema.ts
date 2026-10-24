/** JSON Schema export for cross-language contract sync (Node ↔ Python). */
import { zodToJsonSchema } from 'zod-to-json-schema';

import * as ai from './ai.js';
import * as dto from './manifest.js';
import * as support from './support.js';

export function exportJsonSchemas(): Record<string, unknown> {
  return {
    ModuleUiRoute: zodToJsonSchema(dto.ModuleUiRouteSchema),
    ModuleNavEntry: zodToJsonSchema(dto.ModuleNavEntrySchema),
    ModuleBackgroundPoller: zodToJsonSchema(dto.ModuleBackgroundPollerSchema),
    ModuleManifest: zodToJsonSchema(dto.ModuleManifestSchema),
    ManifestModule: zodToJsonSchema(dto.ManifestModuleSchema),
    SystemManifest: zodToJsonSchema(dto.SystemManifestSchema),
    ModuleInfo: zodToJsonSchema(dto.ModuleInfoSchema),
    StageStatus: zodToJsonSchema(dto.StageStatusSchema),
    RunStatus: zodToJsonSchema(dto.RunStatusSchema),
    StageRunDto: zodToJsonSchema(dto.StageRunDtoSchema),
    RunDto: zodToJsonSchema(dto.RunDtoSchema),
    DecisionRecordDto: zodToJsonSchema(dto.DecisionRecordDtoSchema),
    HealthReport: zodToJsonSchema(dto.HealthReportSchema),
    AiEmbedRequest: zodToJsonSchema(ai.AiEmbedRequestSchema),
    AiEmbedResponse: zodToJsonSchema(ai.AiEmbedResponseSchema),
    AiClassifyRequest: zodToJsonSchema(ai.AiClassifyRequestSchema),
    AiCategoryScore: zodToJsonSchema(ai.AiCategoryScoreSchema),
    AiClassifyResponse: zodToJsonSchema(ai.AiClassifyResponseSchema),
    AutoReplyPolicyDto: zodToJsonSchema(support.AutoReplyPolicyDtoSchema),
    AutoReplyPolicyUpdate: zodToJsonSchema(support.AutoReplyPolicyUpdateSchema),
    TicketConfirmationRequest: zodToJsonSchema(support.TicketConfirmationRequestSchema),
    TicketConfirmationResponse: zodToJsonSchema(support.TicketConfirmationResponseSchema),
  };
}
