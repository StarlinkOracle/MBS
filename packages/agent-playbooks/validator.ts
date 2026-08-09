import { createRequire } from 'node:module';

import type {
  ErrorObject,
  ValidateFunction,
} from 'ajv';

import {
  LoadedPack,
  PlaybookValidationError,
  type PlaybookValidationIssue,
} from './types.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ['unknown schema validation error'];
  }
  return errors.map((error) => {
    const path = error.instancePath?.trim() || '/';
    return `${path} ${error.message ?? 'is invalid'}`.trim();
  });
}

function addSchemaIssues<T>(
  issues: PlaybookValidationIssue[],
  label: string,
  validator: ValidateFunction<T>,
  value: unknown,
) {
  if (validator(value)) {
    return;
  }
  for (const message of formatAjvErrors(validator.errors)) {
    issues.push({
      code: 'SCHEMA_VALIDATION_FAILED',
      message: `${label}: ${message}`,
    });
  }
}

function addUniqueStableIdIssues(
  issues: PlaybookValidationIssue[],
  rows: Array<{ stableId: string }>,
  entityType: 'skill' | 'playbook',
) {
  const seen = new Set<string>();
  for (const row of rows) {
    const stableId = row.stableId;
    if (seen.has(stableId)) {
      issues.push({
        code: 'DUPLICATE_STABLE_ID',
        message: `Duplicate ${entityType} stableId: ${stableId}`,
      });
      continue;
    }
    seen.add(stableId);
  }
}

function addUniqueCatalogToolIssues(
  issues: PlaybookValidationIssue[],
  tools: Array<{ toolName: string }>,
) {
  const seen = new Set<string>();
  for (const tool of tools) {
    const toolName = typeof tool.toolName === 'string' ? tool.toolName.trim() : '';
    if (!toolName) {
      continue;
    }
    if (seen.has(toolName)) {
      issues.push({
        code: 'DUPLICATE_TOOL_CATALOG_ENTRY',
        message: `Duplicate tool catalog entry: ${toolName}`,
        details: {
          toolName,
        },
      });
      continue;
    }
    seen.add(toolName);
  }
}

function addUniqueSkillStepIssues(
  issues: PlaybookValidationIssue[],
  skill: LoadedPack['skills'][number],
) {
  const seen = new Set<string>();
  for (const step of skill.toolSequence) {
    const stableId = typeof step.stableId === 'string' ? step.stableId.trim() : '';
    if (!stableId) {
      continue;
    }
    if (seen.has(stableId)) {
      issues.push({
        code: 'DUPLICATE_STEP_STABLE_ID',
        message: `Skill ${skill.stableId} has duplicate step stableId: ${stableId}`,
        details: {
          skillStableId: skill.stableId,
          stepStableId: stableId,
        },
      });
      continue;
    }
    seen.add(stableId);
  }
}

function buildCatalogLookup(pack: LoadedPack): Set<string> {
  return new Set(
    pack.toolsCatalog.tools
      .map((entry) => entry.toolName)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim()),
  );
}

export function validatePack(pack: LoadedPack): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateToolsCatalog = ajv.compile(pack.schemas.toolsCatalog);
  const validateSkill = ajv.compile(pack.schemas.skill);
  const validatePlaybook = ajv.compile(pack.schemas.playbook);

  const issues: PlaybookValidationIssue[] = [];
  addSchemaIssues(issues, 'tools_catalog.json', validateToolsCatalog, pack.toolsCatalog);
  for (const skill of pack.skills) {
    addSchemaIssues(issues, `skill:${skill.stableId}`, validateSkill, skill);
  }
  for (const playbook of pack.playbooks) {
    addSchemaIssues(issues, `playbook:${playbook.stableId}`, validatePlaybook, playbook);
  }

  addUniqueStableIdIssues(issues, pack.skills, 'skill');
  addUniqueStableIdIssues(issues, pack.playbooks, 'playbook');
  addUniqueCatalogToolIssues(issues, pack.toolsCatalog.tools);
  for (const skill of pack.skills) {
    addUniqueSkillStepIssues(issues, skill);
  }

  const catalogTools = buildCatalogLookup(pack);
  for (const skill of pack.skills) {
    for (const step of skill.toolSequence) {
      if (!catalogTools.has(step.toolName)) {
        issues.push({
          code: 'UNKNOWN_TOOL_REFERENCE',
          message: `Skill ${skill.stableId} step ${step.stableId} references unknown tool ${step.toolName}`,
          details: {
            skillStableId: skill.stableId,
            stepStableId: step.stableId,
            toolName: step.toolName,
          },
        });
      }
    }
  }

  const skillsLookup = new Set(pack.skills.map((skill) => skill.stableId));
  for (const playbook of pack.playbooks) {
    for (const skillStableId of playbook.skillSequence) {
      if (!skillsLookup.has(skillStableId)) {
        issues.push({
          code: 'UNKNOWN_SKILL_REFERENCE',
          message: `Playbook ${playbook.stableId} references unknown skill ${skillStableId}`,
          details: {
            playbookStableId: playbook.stableId,
            skillStableId,
          },
        });
      }
    }

    if (playbook.status === 'READY') {
      for (const toolName of playbook.requiresTools) {
        if (!catalogTools.has(toolName)) {
          issues.push({
            code: 'UNKNOWN_REQUIRED_TOOL',
            message: `READY playbook ${playbook.stableId} references unknown requiresTools entry ${toolName}`,
            details: {
              playbookStableId: playbook.stableId,
              toolName,
            },
          });
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new PlaybookValidationError(issues);
  }
}
