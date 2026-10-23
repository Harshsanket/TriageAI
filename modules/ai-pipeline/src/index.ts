/**
 * ai-pipeline (Phase 3): embedding-similarity classification + deterministic
 * routing. No generative LLM is involved, ever (REQUIREMENTS FR-2/FR-3).
 *
 * This module owns the classification/routing configuration tables and the
 * workflow stage handlers; ticket state lives in the `support` module, which
 * consumes these stage outputs in its own `support.ticket.apply` stage.
 */
import { z } from 'zod';

import type { TriageModule } from '@triageai/kernel';

const configSchema = z.object({}).strict();

interface CategoryRow {
  [key: string]: unknown;
  id: string;
  label: string;
  threshold: number;
  margin: number;
  safety_critical: boolean;
  enabled: boolean;
}

interface RuleRow {
  [key: string]: unknown;
  id: string;
  rules_version: number;
  priority: number;
  category: string | null;
  team: string;
  priority_level: string;
  escalate: boolean;
}

const SEED_CATEGORIES: Array<[string, string, number, number, boolean]> = [
  ['general_question', 'General question', 0.4, 0.03, false],
  ['known_troubleshooting', 'Known troubleshooting', 0.42, 0.04, false],
  ['feature_question', 'Feature question', 0.42, 0.04, false],
  ['billing', 'Billing', 0.45, 0.05, false],
  ['bug_report', 'Bug report', 0.45, 0.05, false],
  ['security', 'Security', 0.5, 0.08, true],
  ['account', 'Account', 0.45, 0.05, false],
  ['refund_dispute', 'Refund dispute', 0.45, 0.05, false],
];

const SEED_RULES: Array<[string, number, string | null, string, string, boolean]> = [
  ['rule-security', 1, 'security', 'human-review', 'urgent', true],
  ['rule-billing', 10, 'billing', 'billing', 'high', false],
  ['rule-refund', 11, 'refund_dispute', 'billing', 'high', false],
  ['rule-bug', 20, 'bug_report', 'engineering', 'high', false],
  ['rule-account', 25, 'account', 'accounts', 'normal', false],
  ['rule-troubleshooting', 30, 'known_troubleshooting', 'support', 'normal', false],
  ['rule-feature', 40, 'feature_question', 'product', 'low', false],
  ['rule-general', 50, 'general_question', 'support', 'low', false],
  ['rule-unknown', 999, null, 'human-review', 'normal', true],
];

function ruleSql(): string {
  const values = SEED_RULES.map(
    ([id, priority, category, team, level, escalate]) =>
      `('${id}', 1, ${priority}, ${category === null ? 'NULL' : `'${category}'`}, '${team}', '${level}', ${escalate})`,
  ).join(',\n');
  return `INSERT INTO ai_routing_rules (id, rules_version, priority, category, team, priority_level, escalate)
          VALUES ${values}
          ON CONFLICT (id) DO NOTHING;`;
}

function categorySql(): string {
  const values = SEED_CATEGORIES.map(
    ([id, label, threshold, margin, safety]) =>
      `('${id}', '${label}', ${threshold}, ${margin}, ${safety})`,
  ).join(',\n');
  return `INSERT INTO ai_categories (id, label, threshold, margin, safety_critical)
          VALUES ${values}
          ON CONFLICT (id) DO NOTHING;`;
}

const MIGRATIONS = [
  {
    id: '0001-ai-pipeline-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS ai_categories (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        threshold REAL NOT NULL,
        margin REAL NOT NULL,
        safety_critical BOOLEAN NOT NULL DEFAULT false,
        enabled BOOLEAN NOT NULL DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS ai_routing_rules (
        id TEXT PRIMARY KEY,
        rules_version INT NOT NULL,
        priority INT NOT NULL,
        category TEXT,
        team TEXT NOT NULL,
        priority_level TEXT NOT NULL,
        escalate BOOLEAN NOT NULL DEFAULT false,
        enabled BOOLEAN NOT NULL DEFAULT true,
        note TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ai_policy_versions (
        version INT PRIMARY KEY,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ${categorySql()}
      INSERT INTO ai_policy_versions (version, note) VALUES (1, 'phase-3 seed') ON CONFLICT (version) DO NOTHING;
      ${ruleSql()}
    `,
    dropSql:
      'DROP TABLE IF EXISTS ai_policy_versions; DROP TABLE IF EXISTS ai_routing_rules; DROP TABLE IF EXISTS ai_categories;',
  },
];

export const aiPipelineModule: TriageModule = {
  id: 'ai-pipeline',
  version: '0.1.0',
  capabilities: ['embedder', 'classifier'],
  dependsOn: {
    modules: [],
    capabilities: [{ capability: 'embedder' }, { capability: 'classifier' }],
  },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['ai_categories', 'ai_routing_rules', 'ai_policy_versions'],
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: {
    health: async () => ({
      status: 'healthy',
      detail: 'similarity classifier + deterministic routing',
    }),
  },
  register(ctx) {
    ctx.registerStageHandler('ai.classify', {
      execute: async (stage) => {
        const classifier = ctx.capabilities.classifier;
        if (!classifier) throw new Error('classifier capability is not configured');
        const input = stage.input as { subject?: string; body?: string };
        const text = `${input.subject ?? ''}\n\n${input.body ?? ''}`.trim();
        if (!text) throw new Error('classify stage received empty text');

        const result = await classifier.classify(text);
        const rows = await ctx.database.query<CategoryRow>(
          `SELECT id, label, threshold, margin, safety_critical, enabled FROM ai_categories`,
        );
        const configured = new Map(rows.map((row) => [row.id, row]));
        const categoryConfig = configured.get(result.category);

        const reasonCodes: string[] = [];
        let category = result.category;
        let safetyCritical = false;
        let threshold = 0.35;
        let marginThreshold = 0.05;

        if (category === 'unknown') {
          reasonCodes.push('classifier_unknown');
        } else if (!categoryConfig || !categoryConfig.enabled) {
          reasonCodes.push('category_not_configured');
          category = 'unknown';
        } else {
          threshold = categoryConfig.threshold;
          marginThreshold = categoryConfig.margin;
          safetyCritical = categoryConfig.safety_critical;
          if (result.confidence < threshold) {
            reasonCodes.push(`below_confidence:${threshold}`);
            category = 'unknown';
          } else if (result.margin < marginThreshold) {
            reasonCodes.push(`below_margin:${marginThreshold}`);
            category = 'unknown';
          }
          if (safetyCritical) reasonCodes.push('safety_critical');
        }

        return {
          output: {
            category,
            confidence: result.confidence,
            margin: result.margin,
            method: result.method,
            modelVersion: result.modelVersion,
            safetyCritical,
            reasonCodes,
            thresholds: { confidence: threshold, margin: marginThreshold },
            policyVersion: 1,
          },
          evidence: {
            kind: 'deterministic',
            classifierMethod: result.method,
            modelVersion: result.modelVersion,
            thresholds: { confidence: threshold, margin: marginThreshold },
            reasonCodes,
          },
          deterministic: {
            thresholds: { confidence: threshold, margin: marginThreshold },
            policyVersion: 1,
            rawCategory: result.category,
            rawConfidence: result.confidence,
            rawMargin: result.margin,
          },
        };
      },
    });

    ctx.registerStageHandler('ai.route', {
      execute: async (stage) => {
        const input = stage.input as {
          category?: string;
          safetyCritical?: boolean;
          confidence?: number;
        };
        const category = input.category ?? 'unknown';
        const versions = await ctx.database.query<{ version: number }>(
          `SELECT MAX(rules_version)::int AS version FROM ai_routing_rules`,
        );
        const rulesVersion = versions[0]?.version ?? 1;
        const rules = await ctx.database.query<RuleRow>(
          `SELECT id, rules_version, priority, category, team, priority_level, escalate
           FROM ai_routing_rules
           WHERE rules_version = $1 AND enabled AND (category = $2 OR category IS NULL)
           ORDER BY priority ASC`,
          [rulesVersion, category],
        );
        const rule = rules[0];
        const reasons: string[] = [];
        if (!rule) {
          reasons.push('no_matching_rule');
        }
        if (category === 'unknown') reasons.push('category_unknown');
        if (input.safetyCritical) reasons.push('safety_critical');

        const escalate =
          Boolean(input.safetyCritical) || category === 'unknown' || !rule || rule.escalate;
        return {
          output: {
            category,
            team: rule?.team ?? 'human-review',
            priority: rule?.priority_level ?? 'normal',
            escalate,
            ruleIds: rule ? [rule.id] : [],
            rulesVersion,
            reasons,
          },
          evidence: {
            kind: 'deterministic',
            rulesVersion,
            ruleIds: rule ? [rule.id] : [],
            category,
            reasons,
          },
          deterministic: {
            rulesVersion,
            ruleIds: rule ? [rule.id] : [],
            category,
            escalate,
          },
        };
      },
    });
  },
};
