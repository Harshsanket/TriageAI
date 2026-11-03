/**
 * User-skill API (ADR-0060): the home drawer and `/config` -> Skills share the
 * same registry. Content is instructions only; nothing here executes a skill.
 */
import type { FastifyInstance } from 'fastify';

import {
  SkillCreateRequestSchema,
  SkillImportRequestSchema,
  SkillSuggestionActionSchema,
  SkillUpdateRequestSchema,
} from '@triageai/contracts';
import type { Kernel } from '@triageai/kernel';
import { AppError, invalid, notFound } from '@triageai/kernel';

import { config } from '../platform/config.js';
import {
  DEFAULT_SKILL_SOURCES,
  createSkill,
  listUserSkills,
  deleteSkill,
  importSkillFromGithub,
  listSkillIndex,
  readSkillDocument,
  resolveSuggestion,
  updateSkill,
} from '../services/skills.js';

export function registerSkillRoutes(app: FastifyInstance, kernel: Kernel): void {
  const actor = (request: { principal?: { email?: string; userId?: string } }) =>
    request.principal?.email ?? request.principal?.userId ?? 'local-developer';
  const actorId = (request: { principal?: { userId?: string } }) =>
    request.principal?.userId ?? null;

  app.get('/api/v1/skills', async (request) =>
    listSkillIndex(kernel.database, config.skillsRoot, actorId(request), request.principal?.role),
  );

  app.get('/api/v1/skills/sources', async () => {
    const imported = await kernel.database
      .query<{
        source_url: string | null;
        source_ref: string | null;
        name: string;
        version: number;
      }>(
        `SELECT source_url, source_ref, name, version FROM user_skills WHERE provenance = 'github'`,
      )
      .catch(() => []);
    return {
      sources: DEFAULT_SKILL_SOURCES.map((source) => ({
        ...source,
        status: imported.some((row) => row.source_url?.includes(source.repo))
          ? 'imported'
          : 'not_imported',
        pinned: imported
          .filter((row) => row.source_url?.includes(source.repo))
          .map((row) => ({ name: row.name, version: row.version, ref: row.source_ref })),
      })),
    };
  });

  app.get('/api/v1/skills/export', async (request) => ({
    skills: await listUserSkills(kernel.database, actorId(request), request.principal?.role),
  }));

  app.get('/api/v1/skills/:name', async (request) => {
    const { name } = request.params as { name: string };
    const skill = await readSkillDocument(
      kernel.database,
      config.skillsRoot,
      name,
      actorId(request),
      request.principal?.role,
    );
    if (!skill) throw notFound(`skill ${name} is not installed`);
    return skill;
  });

  app.post('/api/v1/skills', async (request) => {
    const body = SkillCreateRequestSchema.parse(request.body ?? {});
    try {
      return {
        skill: await createSkill(
          kernel,
          actorId(request),
          request.principal?.role,
          body,
          actor(request),
        ),
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw invalid((err as Error).message);
    }
  });

  app.patch('/api/v1/skills/:id', async (request) => {
    const body = SkillUpdateRequestSchema.parse(request.body ?? {});
    const skill = await updateSkill(
      kernel,
      (request.params as { id: string }).id,
      actorId(request),
      request.principal?.role,
      body,
      actor(request),
    );
    if (!skill) throw notFound('skill not found');
    return { skill };
  });

  app.delete('/api/v1/skills/:id', async (request) => {
    const deleted = await deleteSkill(
      kernel,
      (request.params as { id: string }).id,
      actorId(request),
      request.principal?.role,
      actor(request),
    );
    if (!deleted) throw notFound('skill not found');
    return { deleted: true };
  });

  app.post('/api/v1/skills/import', async (request) => {
    const body = SkillImportRequestSchema.parse(request.body ?? {});
    try {
      return {
        skill: await importSkillFromGithub(kernel, actorId(request), body, actor(request)),
      };
    } catch (err) {
      throw invalid((err as Error).message);
    }
  });

  app.post('/api/v1/skills/:id/suggestion', async (request) => {
    const body = SkillSuggestionActionSchema.parse(request.body ?? {});
    const skill = await resolveSuggestion(
      kernel,
      (request.params as { id: string }).id,
      actorId(request),
      request.principal?.role,
      body.action,
      actor(request),
    );
    if (body.action === 'accept' && !skill) throw notFound('suggestion not found');
    return { skill, ignored: body.action === 'ignore' };
  });
}
