/** JSON Schema export for cross-language contract sync (Node ↔ Python). */
import { zodToJsonSchema } from 'zod-to-json-schema';

import * as ai from './ai.js';
import * as feedback from './feedback.js';
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
    AiClassifyModel: zodToJsonSchema(ai.AiClassifyModelSchema),
    AiCategoryScore: zodToJsonSchema(ai.AiCategoryScoreSchema),
    AiClassifyResponse: zodToJsonSchema(ai.AiClassifyResponseSchema),
    AutoReplyPolicyDto: zodToJsonSchema(support.AutoReplyPolicyDtoSchema),
    AutoReplyPolicyUpdate: zodToJsonSchema(support.AutoReplyPolicyUpdateSchema),
    TicketTriagePolicyDto: zodToJsonSchema(support.TicketTriagePolicyDtoSchema),
    TicketTriageOverrideRequest: zodToJsonSchema(support.TicketTriageOverrideRequestSchema),
    TicketConfirmationRequest: zodToJsonSchema(support.TicketConfirmationRequestSchema),
    TicketConfirmationResponse: zodToJsonSchema(support.TicketConfirmationResponseSchema),
    CandidateDto: zodToJsonSchema(feedback.CandidateDtoSchema),
    CandidateReviewRequest: zodToJsonSchema(feedback.CandidateReviewRequestSchema),
    CandidateExportDto: zodToJsonSchema(feedback.CandidateExportDtoSchema),
    CorrectionRequest: zodToJsonSchema(feedback.CorrectionRequestSchema),
    DatasetDto: zodToJsonSchema(feedback.DatasetDtoSchema),
    DatasetBuildRequest: zodToJsonSchema(feedback.DatasetBuildRequestSchema),
    DatasetExportDto: zodToJsonSchema(feedback.DatasetExportDtoSchema),
    ModelAssetDto: zodToJsonSchema(feedback.ModelAssetDtoSchema),
    RegisterModelRequest: zodToJsonSchema(feedback.RegisterModelRequestSchema),
    PromoteModelRequest: zodToJsonSchema(feedback.PromoteModelRequestSchema),
    RollbackModelRequest: zodToJsonSchema(feedback.RollbackModelRequestSchema),
    EvalReportInput: zodToJsonSchema(feedback.EvalReportInputSchema),
    EvalReportDto: zodToJsonSchema(feedback.EvalReportDtoSchema),
  };
}
