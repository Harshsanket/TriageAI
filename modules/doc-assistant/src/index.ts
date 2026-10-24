/**
 * doc-assistant (Phase 4): answers questions about this repository's own docs,
 * citing file paths, or refusing when the docs do not cover the question.
 * Uses the same retriever/generator capabilities and RAG prompt helper as the
 * runtime KB (ADR-0006), with a separate `project_docs` collection.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { buildRagPrompt, chunkText, finalizeAnswer, runValidation } from '@triageai/rag';
import type { TriageModule } from '@triageai/kernel';

const configSchema = z
  .object({
    docsDir: z.string().optional(),
    collection: z.string().default('project_docs'),
    // Docs answers paraphrase ADR prose; 0.6 coverage refused correct answers.
    groundingThreshold: z.number().min(0).max(1).default(0.45),
  })
  .strict();

async function walkMarkdown(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkMarkdown(full)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function firstHeading(text: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(text);
  return match?.[1]?.trim() ?? fallback;
}

export const docAssistantModule: TriageModule = {
  id: 'doc-assistant',
  version: '0.1.0',
  capabilities: ['embedder', 'vectorStore', 'retriever', 'generator', 'validator'],
  dependsOn: {
    modules: [],
    capabilities: [
      { capability: 'embedder' },
      { capability: 'vectorStore' },
      { capability: 'retriever' },
      { capability: 'generator' },
      { capability: 'validator', optional: true },
    ],
  },
  configSchema,
  manifest: {
    routes: [{ path: '/doc-assistant', title: 'Doc assistant' }],
    nav: [{ label: 'Doc assistant', order: 40, path: '/doc-assistant' }],
    background: [],
  },
  lifecycle: {
    health: async () => ({
      status: 'degraded',
      detail: 'requires docs ingestion + a local generator',
    }),
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const { collection } = options;
    const candidates = [
      options.docsDir,
      path.resolve(process.cwd(), 'docs'),
      path.resolve(process.cwd(), '../../docs'),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const docsDir =
      candidates.find((candidate) => existsSync(candidate)) ?? (candidates[0] as string);

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/doc-assistant/reingest',
      handler: async () => {
        const embedder = ctx.capabilities.embedder;
        const vectorStore = ctx.capabilities.vectorStore;
        if (!embedder || !vectorStore)
          throw new Error('doc-assistant requires embedder + vectorStore');

        const files = await walkMarkdown(docsDir);
        let totalChunks = 0;
        for (const file of files) {
          const relative = path.relative(docsDir, file).split(path.sep).join('/');
          const text = await readFile(file, 'utf8');
          const pieces = chunkText(text);
          totalChunks += pieces.length;
          await vectorStore.deleteByDocument(collection, relative);
          for (let offset = 0; offset < pieces.length; offset += 32) {
            const batch = pieces.slice(offset, offset + 32);
            const embedded = await embedder.embed(batch);
            await vectorStore.upsert(
              batch.map((piece, index) => ({
                id: `${relative}:${offset + index}`,
                collection,
                documentId: relative,
                text: piece,
                metadata: {
                  path: relative,
                  title: firstHeading(text, relative),
                },
                embedding: embedded.vectors[index] as number[],
              })),
            );
          }
        }
        return { docsDir, documents: files.length, chunks: totalChunks };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/doc-assistant/ask',
      handler: async (request) => {
        const retriever = ctx.capabilities.retriever;
        const generator = ctx.capabilities.generator;
        if (!retriever || !generator) {
          throw new Error('doc-assistant requires retriever + generator capabilities');
        }
        const body = z
          .object({
            question: z.string().min(1).max(4000),
            limit: z.number().int().positive().max(10).default(5),
          })
          .parse(request.body);

        const retrieved = await retriever.search(collection, body.question, { limit: body.limit });
        const refusal = 'That is not documented (yet).';
        if (!retrieved.gate.sufficient || retrieved.chunks.length === 0) {
          return {
            answer: refusal,
            refused: true,
            reason: 'insufficient_retrieval',
            citations: [],
            gate: retrieved.gate,
          };
        }

        const chunks = retrieved.chunks.map((chunk) => ({
          ref: (chunk.metadata.path as string | undefined) ?? chunk.documentId,
          text: chunk.text,
          score: chunk.score,
        }));
        const prompt = buildRagPrompt({ question: body.question, chunks, style: 'docs' });
        const generated = await generator.generate(prompt, { maxTokens: 384 });
        const sources = chunks.map((chunk) => ({ ref: chunk.ref, text: chunk.text }));
        const policy = { maxChars: 8000, groundingThreshold: options.groundingThreshold };
        const validation = ctx.capabilities.validator
          ? await ctx.capabilities.validator.validate(
              { text: generated.text, sources, question: body.question },
              policy,
            )
          : runValidation({ text: generated.text, sources, question: body.question }, policy);
        if (!validation.passed) {
          return {
            answer: refusal,
            refused: true,
            reason: 'validation_failed',
            checks: validation.checks,
            citations: [],
            gate: retrieved.gate,
          };
        }
        const finalized = finalizeAnswer({
          answer: generated.text,
          sources,
          threshold: options.groundingThreshold,
        });
        if (finalized.refused) {
          return {
            answer: refusal,
            refused: true,
            reason: finalized.reason,
            citations: [],
            citationSource: finalized.citationSource,
            grounding: finalized.grounding,
            gate: retrieved.gate,
          };
        }
        return {
          answer: finalized.answer,
          refused: false,
          citations: finalized.citations,
          citationSource: finalized.citationSource,
          grounding: finalized.grounding,
          modelVersion: generated.modelVersion,
          gate: retrieved.gate,
        };
      },
    });
  },
};
