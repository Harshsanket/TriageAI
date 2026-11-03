/** JSON Schema export for cross-language contract sync (Node ↔ Python). */
import { z } from 'zod';

import * as ai from './ai.js';
import * as chat from './chat.js';
import * as dashboard from './dashboard.js';
import * as deadletters from './deadletters.js';
import * as errors from './errors.js';
import * as feedback from './feedback.js';
import * as health from './health.js';
import * as integrations from './integrations.js';
import * as kb from './kb.js';
import * as jobs from './jobs.js';
import * as dataExtract from './dataExtract.js';
import * as agents from './agents.js';
import * as appearance from './appearance.js';
import * as dto from './manifest.js';
import * as setup from './setup.js';
import * as mp1 from './module-protocol.js';
import * as support from './support.js';

export function exportJsonSchemas(): Record<string, unknown> {
  return {
    ModuleUiRoute: z.toJSONSchema(dto.ModuleUiRouteSchema),
    ModuleNavEntry: z.toJSONSchema(dto.ModuleNavEntrySchema),
    ModuleBackgroundPoller: z.toJSONSchema(dto.ModuleBackgroundPollerSchema),
    ModuleManifest: z.toJSONSchema(dto.ModuleManifestSchema),
    ManifestModule: z.toJSONSchema(dto.ManifestModuleSchema),
    SystemManifest: z.toJSONSchema(dto.SystemManifestSchema),
    ModuleInfo: z.toJSONSchema(dto.ModuleInfoSchema),
    SystemDashboard: z.toJSONSchema(dashboard.SystemDashboardSchema),
    ErrorCategory: z.toJSONSchema(errors.ErrorCategorySchema),
    ErrorEnvelope: z.toJSONSchema(errors.ErrorEnvelopeSchema),
    StructuredError: z.toJSONSchema(errors.StructuredErrorSchema),
    DeadLetterDto: z.toJSONSchema(deadletters.DeadLetterDtoSchema),
    DeadLetterReplayResponse: z.toJSONSchema(deadletters.DeadLetterReplayResponseSchema),
    DeadLetterDiscardResponse: z.toJSONSchema(deadletters.DeadLetterDiscardResponseSchema),
    StageStatus: z.toJSONSchema(dto.StageStatusSchema),
    RunStatus: z.toJSONSchema(dto.RunStatusSchema),
    StageRunDto: z.toJSONSchema(dto.StageRunDtoSchema),
    RunDto: z.toJSONSchema(dto.RunDtoSchema),
    DecisionRecordDto: z.toJSONSchema(dto.DecisionRecordDtoSchema),
    HealthReport: z.toJSONSchema(dto.HealthReportSchema),
    HealthResponse: z.toJSONSchema(health.HealthResponseSchema),
    AiEmbedRequest: z.toJSONSchema(ai.AiEmbedRequestSchema),
    AiEmbedResponse: z.toJSONSchema(ai.AiEmbedResponseSchema),
    AiClassifyRequest: z.toJSONSchema(ai.AiClassifyRequestSchema),
    AiClassifyModel: z.toJSONSchema(ai.AiClassifyModelSchema),
    AiCategoryScore: z.toJSONSchema(ai.AiCategoryScoreSchema),
    AiClassifyResponse: z.toJSONSchema(ai.AiClassifyResponseSchema),
    KbDocumentDto: z.toJSONSchema(kb.KbDocumentDtoSchema),
    KbDocumentCreateRequest: z.toJSONSchema(kb.KbDocumentCreateRequestSchema),
    KbDocumentWriteResponse: z.toJSONSchema(kb.KbDocumentWriteResponseSchema),
    KbSearchRequest: z.toJSONSchema(kb.KbSearchRequestSchema),
    KbSearchResponse: z.toJSONSchema(kb.KbSearchResponseSchema),
    KbSourceDto: z.toJSONSchema(kb.KbSourceDtoSchema),
    KbSourceCreateRequest: z.toJSONSchema(kb.KbSourceCreateRequestSchema),
    KbSourceUpdateRequest: z.toJSONSchema(kb.KbSourceUpdateRequestSchema),
    KbDataProcessing: z.toJSONSchema(kb.KbDataProcessingSchema),
    KbStorageStats: z.toJSONSchema(kb.KbStorageStatsSchema),
    KbImportRequest: z.toJSONSchema(kb.KbImportRequestSchema),
    KbImportResponse: z.toJSONSchema(kb.KbImportResponseSchema),
    JobDto: z.toJSONSchema(jobs.JobDtoSchema),
    JobsResponse: z.toJSONSchema(jobs.JobsResponseSchema),
    ExtractedDatasetDto: z.toJSONSchema(dataExtract.ExtractedDatasetDtoSchema),
    ExtractedRowDto: z.toJSONSchema(dataExtract.ExtractedRowDtoSchema),
    ImportDatasetRequest: z.toJSONSchema(dataExtract.ImportDatasetRequestSchema),
    ImportDatasetResponse: z.toJSONSchema(dataExtract.ImportDatasetResponseSchema),
    DatasetSummary: z.toJSONSchema(dataExtract.DatasetSummarySchema),
    AgentPreference: z.toJSONSchema(agents.AgentPreferenceSchema),
    AgentDefaultsRequest: z.toJSONSchema(agents.AgentDefaultsRequestSchema),
    AgentDefaultsResponse: z.toJSONSchema(agents.AgentDefaultsResponseSchema),
    AppearancePreferences: z.toJSONSchema(appearance.AppearancePreferencesSchema),
    UserPreferences: z.toJSONSchema(appearance.UserPreferencesSchema),
    PreferencesResponse: z.toJSONSchema(appearance.PreferencesResponseSchema),
    ChatConversationCreateRequest: z.toJSONSchema(chat.ChatConversationCreateRequestSchema),
    ChatConversationSummary: z.toJSONSchema(chat.ChatConversationSummarySchema),
    ChatConversationDto: z.toJSONSchema(chat.ChatConversationDtoSchema),
    ChatSendMessageRequest: z.toJSONSchema(chat.ChatSendMessageRequestSchema),
    ChatSendMessageResponse: z.toJSONSchema(chat.ChatSendMessageResponseSchema),
    SetupStatus: z.toJSONSchema(setup.SetupStatusSchema),
    SetupAnswers: z.toJSONSchema(setup.SetupAnswersSchema),
    SetupPlan: z.toJSONSchema(setup.SetupPlanSchema),
    HardwareProfile: z.toJSONSchema(setup.HardwareProfileSchema),
    CatalogModel: z.toJSONSchema(setup.CatalogModelSchema),
    AutoReplyPolicyDto: z.toJSONSchema(support.AutoReplyPolicyDtoSchema),
    AutoReplyPolicyUpdate: z.toJSONSchema(support.AutoReplyPolicyUpdateSchema),
    TicketTriagePolicyDto: z.toJSONSchema(support.TicketTriagePolicyDtoSchema),
    TicketTriageOverrideRequest: z.toJSONSchema(support.TicketTriageOverrideRequestSchema),
    TicketConfirmationRequest: z.toJSONSchema(support.TicketConfirmationRequestSchema),
    TicketConfirmationResponse: z.toJSONSchema(support.TicketConfirmationResponseSchema),
    CandidateDto: z.toJSONSchema(feedback.CandidateDtoSchema),
    CandidateReviewRequest: z.toJSONSchema(feedback.CandidateReviewRequestSchema),
    CandidateExportDto: z.toJSONSchema(feedback.CandidateExportDtoSchema),
    FeedbackInsights: z.toJSONSchema(feedback.FeedbackInsightsSchema),
    CorrectionRequest: z.toJSONSchema(feedback.CorrectionRequestSchema),
    DatasetDto: z.toJSONSchema(feedback.DatasetDtoSchema),
    DatasetBuildRequest: z.toJSONSchema(feedback.DatasetBuildRequestSchema),
    DatasetExportDto: z.toJSONSchema(feedback.DatasetExportDtoSchema),
    ModelAssetDto: z.toJSONSchema(feedback.ModelAssetDtoSchema),
    RegisterModelRequest: z.toJSONSchema(feedback.RegisterModelRequestSchema),
    PromoteModelRequest: z.toJSONSchema(feedback.PromoteModelRequestSchema),
    RollbackModelRequest: z.toJSONSchema(feedback.RollbackModelRequestSchema),
    EvalReportInput: z.toJSONSchema(feedback.EvalReportInputSchema),
    EvalReportDto: z.toJSONSchema(feedback.EvalReportDtoSchema),
    IntegrationActionDto: z.toJSONSchema(integrations.IntegrationActionDtoSchema),
    IntegrationApprovalRequest: z.toJSONSchema(integrations.IntegrationApprovalRequestSchema),
    Mp1Envelope: z.toJSONSchema(mp1.Mp1EnvelopeSchema),
    Mp1Response: {},
    Mp1Health: z.toJSONSchema(mp1.Mp1EmptyPayloadSchema),
    Mp1HandshakePayload: z.toJSONSchema(mp1.Mp1HandshakePayloadSchema),
    Mp1StageInvokePayload: z.toJSONSchema(mp1.Mp1StageInvokePayloadSchema),
    Mp1RouteHandlePayload: z.toJSONSchema(mp1.Mp1RouteHandlePayloadSchema),
    Mp1EventPublishPayload: z.toJSONSchema(mp1.Mp1EventPublishPayloadSchema),
    Mp1CapabilityCallPayload: z.toJSONSchema(mp1.Mp1CapabilityCallPayloadSchema),
    Mp1RunsGetPayload: z.toJSONSchema(mp1.Mp1RunsGetPayloadSchema),
    Mp1RunsListPayload: z.toJSONSchema(mp1.Mp1RunsListPayloadSchema),
    Mp1KnowledgeQueryPayload: z.toJSONSchema(mp1.Mp1KnowledgeQueryPayloadSchema),
    Mp1AuditAppendPayload: z.toJSONSchema(mp1.Mp1AuditAppendPayloadSchema),
    Mp1TaskCreatePayload: z.toJSONSchema(mp1.Mp1TaskCreatePayloadSchema),
    Mp1TaskUpdatePayload: z.toJSONSchema(mp1.Mp1TaskUpdatePayloadSchema),
  };
}
