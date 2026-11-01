/**
 * Every first-party module the host can boot; config decides which are enabled.
 * Kept separate from `app.ts` so tooling (the `WORKFLOW.md` generator) can
 * introspect module declarations without loading host config or a database.
 */
import type { TriageModule } from '@triageai/kernel';
import { aiPipelineModule } from '@triageai/module-ai-pipeline';
import { chatModule } from '@triageai/module-chat';
import { classifierProviderModule } from '@triageai/module-classifier-provider';
import { embedderProviderModule } from '@triageai/module-embedder-provider';
import { dataExtractModule } from '@triageai/module-data-extract';
import { docAssistantModule } from '@triageai/module-doc-assistant';
import { emailerModule } from '@triageai/module-emailer';
import { echoModule } from '@triageai/module-echo';
import { integrationsGitHubModule } from '@triageai/module-integrations-github';
import { integrationsSlackModule } from '@triageai/module-integrations-slack';
import { kbModule } from '@triageai/module-kb';
import { llmLocalModule } from '@triageai/module-llm-local';
import { publicApiModule } from '@triageai/module-public-api';
import { supportModule } from '@triageai/module-support';

export const MODULES: Record<string, TriageModule> = {
  echo: echoModule,
  chat: chatModule,
  support: supportModule,
  'ai-pipeline': aiPipelineModule,
  kb: kbModule,
  'data-extract': dataExtractModule,
  'doc-assistant': docAssistantModule,
  'integrations-github': integrationsGitHubModule,
  'integrations-slack': integrationsSlackModule,
  'public-api': publicApiModule,
  emailer: emailerModule,
  'llm-local': llmLocalModule,
  'classifier-provider': classifierProviderModule,
  'embedder-provider': embedderProviderModule,
};
