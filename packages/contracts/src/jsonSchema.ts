/** JSON Schema export for cross-language contract sync (Node ↔ Python). */
import { zodToJsonSchema } from 'zod-to-json-schema';

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
    ModuleUiRoute: zodToJsonSchema(dto.ModuleUiRouteSchema),
    ModuleNavEntry: zodToJsonSchema(dto.ModuleNavEntrySchema),
    ModuleBackgroundPoller: zodToJsonSchema(dto.ModuleBackgroundPollerSchema),
    ModuleManifest: zodToJsonSchema(dto.ModuleManifestSchema),
    ManifestModule: zodToJsonSchema(dto.ManifestModuleSchema),
    SystemManifest: zodToJsonSchema(dto.SystemManifestSchema),
    ModuleInfo: zodToJsonSchema(dto.ModuleInfoSchema),
    SystemDashboard: zodToJsonSchema(dashboard.SystemDashboardSchema),
    ErrorCategory: zodToJsonSchema(errors.ErrorCategorySchema),
    ErrorEnvelope: zodToJsonSchema(errors.ErrorEnvelopeSchema),
    StructuredError: zodToJsonSchema(errors.StructuredErrorSchema),
    DeadLetterDto: zodToJsonSchema(deadletters.DeadLetterDtoSchema),
    DeadLetterReplayResponse: zodToJsonSchema(deadletters.DeadLetterReplayResponseSchema),
    DeadLetterDiscardResponse: zodToJsonSchema(deadletters.DeadLetterDiscardResponseSchema),
    StageStatus: zodToJsonSchema(dto.StageStatusSchema),
    RunStatus: zodToJsonSchema(dto.RunStatusSchema),
    StageRunDto: zodToJsonSchema(dto.StageRunDtoSchema),
    RunDto: zodToJsonSchema(dto.RunDtoSchema),
    DecisionRecordDto: zodToJsonSchema(dto.DecisionRecordDtoSchema),
    HealthReport: zodToJsonSchema(dto.HealthReportSchema),
    HealthResponse: zodToJsonSchema(health.HealthResponseSchema),
    AiEmbedRequest: zodToJsonSchema(ai.AiEmbedRequestSchema),
    AiEmbedResponse: zodToJsonSchema(ai.AiEmbedResponseSchema),
    AiClassifyRequest: zodToJsonSchema(ai.AiClassifyRequestSchema),
    AiClassifyModel: zodToJsonSchema(ai.AiClassifyModelSchema),
    AiCategoryScore: zodToJsonSchema(ai.AiCategoryScoreSchema),
    AiClassifyResponse: zodToJsonSchema(ai.AiClassifyResponseSchema),
    KbDocumentDto: zodToJsonSchema(kb.KbDocumentDtoSchema),
    KbDocumentCreateRequest: zodToJsonSchema(kb.KbDocumentCreateRequestSchema),
    KbDocumentWriteResponse: zodToJsonSchema(kb.KbDocumentWriteResponseSchema),
    KbSearchRequest: zodToJsonSchema(kb.KbSearchRequestSchema),
    KbSearchResponse: zodToJsonSchema(kb.KbSearchResponseSchema),
    KbSourceDto: zodToJsonSchema(kb.KbSourceDtoSchema),
    KbSourceCreateRequest: zodToJsonSchema(kb.KbSourceCreateRequestSchema),
    KbSourceUpdateRequest: zodToJsonSchema(kb.KbSourceUpdateRequestSchema),
    KbDataProcessing: zodToJsonSchema(kb.KbDataProcessingSchema),
    KbStorageStats: zodToJsonSchema(kb.KbStorageStatsSchema),
    KbImportRequest: zodToJsonSchema(kb.KbImportRequestSchema),
    KbImportResponse: zodToJsonSchema(kb.KbImportResponseSchema),
    JobDto: zodToJsonSchema(jobs.JobDtoSchema),
    JobsResponse: zodToJsonSchema(jobs.JobsResponseSchema),
    ExtractedDatasetDto: zodToJsonSchema(dataExtract.ExtractedDatasetDtoSchema),
    ExtractedRowDto: zodToJsonSchema(dataExtract.ExtractedRowDtoSchema),
    ImportDatasetRequest: zodToJsonSchema(dataExtract.ImportDatasetRequestSchema),
    ImportDatasetResponse: zodToJsonSchema(dataExtract.ImportDatasetResponseSchema),
    DatasetSummary: zodToJsonSchema(dataExtract.DatasetSummarySchema),
    AgentPreference: zodToJsonSchema(agents.AgentPreferenceSchema),
    AgentDefaultsRequest: zodToJsonSchema(agents.AgentDefaultsRequestSchema),
    AgentDefaultsResponse: zodToJsonSchema(agents.AgentDefaultsResponseSchema),
    AppearancePreferences: zodToJsonSchema(appearance.AppearancePreferencesSchema),
    UserPreferences: zodToJsonSchema(appearance.UserPreferencesSchema),
    PreferencesResponse: zodToJsonSchema(appearance.PreferencesResponseSchema),
    ChatConversationCreateRequest: zodToJsonSchema(chat.ChatConversationCreateRequestSchema),
    ChatConversationSummary: zodToJsonSchema(chat.ChatConversationSummarySchema),
    ChatConversationDto: zodToJsonSchema(chat.ChatConversationDtoSchema),
    ChatSendMessageRequest: zodToJsonSchema(chat.ChatSendMessageRequestSchema),
    ChatSendMessageResponse: zodToJsonSchema(chat.ChatSendMessageResponseSchema),
    SetupStatus: zodToJsonSchema(setup.SetupStatusSchema),
    SetupAnswers: zodToJsonSchema(setup.SetupAnswersSchema),
    SetupPlan: zodToJsonSchema(setup.SetupPlanSchema),
    HardwareProfile: zodToJsonSchema(setup.HardwareProfileSchema),
    CatalogModel: zodToJsonSchema(setup.CatalogModelSchema),
    AutoReplyPolicyDto: zodToJsonSchema(support.AutoReplyPolicyDtoSchema),
    AutoReplyPolicyUpdate: zodToJsonSchema(support.AutoReplyPolicyUpdateSchema),
    TicketTriagePolicyDto: zodToJsonSchema(support.TicketTriagePolicyDtoSchema),
    TicketTriageOverrideRequest: zodToJsonSchema(support.TicketTriageOverrideRequestSchema),
    TicketConfirmationRequest: zodToJsonSchema(support.TicketConfirmationRequestSchema),
    TicketConfirmationResponse: zodToJsonSchema(support.TicketConfirmationResponseSchema),
    CandidateDto: zodToJsonSchema(feedback.CandidateDtoSchema),
    CandidateReviewRequest: zodToJsonSchema(feedback.CandidateReviewRequestSchema),
    CandidateExportDto: zodToJsonSchema(feedback.CandidateExportDtoSchema),
    FeedbackInsights: zodToJsonSchema(feedback.FeedbackInsightsSchema),
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
    IntegrationActionDto: zodToJsonSchema(integrations.IntegrationActionDtoSchema),
    IntegrationApprovalRequest: zodToJsonSchema(integrations.IntegrationApprovalRequestSchema),
    Mp1Envelope: zodToJsonSchema(mp1.Mp1EnvelopeSchema),
    Mp1Response: {},
    Mp1Health: zodToJsonSchema(mp1.Mp1EmptyPayloadSchema),
    Mp1HandshakePayload: zodToJsonSchema(mp1.Mp1HandshakePayloadSchema),
    Mp1StageInvokePayload: zodToJsonSchema(mp1.Mp1StageInvokePayloadSchema),
    Mp1RouteHandlePayload: zodToJsonSchema(mp1.Mp1RouteHandlePayloadSchema),
    Mp1EventPublishPayload: zodToJsonSchema(mp1.Mp1EventPublishPayloadSchema),
    Mp1CapabilityCallPayload: zodToJsonSchema(mp1.Mp1CapabilityCallPayloadSchema),
    Mp1RunsGetPayload: zodToJsonSchema(mp1.Mp1RunsGetPayloadSchema),
    Mp1RunsListPayload: zodToJsonSchema(mp1.Mp1RunsListPayloadSchema),
    Mp1KnowledgeQueryPayload: zodToJsonSchema(mp1.Mp1KnowledgeQueryPayloadSchema),
    Mp1AuditAppendPayload: zodToJsonSchema(mp1.Mp1AuditAppendPayloadSchema),
    Mp1TaskCreatePayload: zodToJsonSchema(mp1.Mp1TaskCreatePayloadSchema),
    Mp1TaskUpdatePayload: zodToJsonSchema(mp1.Mp1TaskUpdatePayloadSchema),
  };
}
