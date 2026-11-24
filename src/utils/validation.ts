import { CURRENT_PROJECT_SCHEMA_VERSION, Project } from '../models/Project';
import { Stem, StemRole, STEM_ROLE_ORDER } from '../models/Stem';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Pure mute and solo state logic for a 4-channel mixer:
 * - When no channels are soloed, play all unmuted channels.
 * - When one or more channels are soloed, play only soloed channels that are not muted.
 * - Muted channels remain silent even when soloed.
 */
export function computeChannelAudibility(
  stems: Pick<Stem, 'stemId' | 'muted' | 'soloed' | 'gain'>[],
  masterGain = 1.0
): Record<string, { audible: boolean; effectiveGain: number }> {
  const anySoloed = stems.some((s) => s.soloed);
  const clampedMaster = Math.max(0, Math.min(1, masterGain));
  const result: Record<string, { audible: boolean; effectiveGain: number }> = {};

  for (const stem of stems) {
    const clampedChannelGain = Math.max(0, Math.min(1, stem.gain));
    let audible = true;

    if (stem.muted) {
      audible = false;
    } else if (anySoloed && !stem.soloed) {
      audible = false;
    }

    result[stem.stemId] = {
      audible,
      effectiveGain: audible ? clampedChannelGain * clampedMaster : 0,
    };
  }

  return result;
}

export function validateLoopRegion(
  loopStartSeconds: number,
  loopEndSeconds: number,
  projectDurationSeconds: number
): ValidationResult {
  const errors: string[] = [];

  if (!Number.isFinite(loopStartSeconds) || loopStartSeconds < 0) {
    errors.push('Loop start must be a non-negative number.');
  }
  if (!Number.isFinite(loopEndSeconds) || loopEndSeconds <= 0) {
    errors.push('Loop end must be greater than 0.');
  }
  if (loopEndSeconds <= loopStartSeconds) {
    errors.push('Loop end must occur strictly after loop start.');
  }
  if (LoopDurationTooShort(loopStartSeconds, loopEndSeconds)) {
    errors.push('Loop region must be at least 0.10 seconds long.');
  }
  if (projectDurationSeconds > 0 && loopStartSeconds >= projectDurationSeconds) {
    errors.push('Loop start cannot exceed project duration.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function LoopDurationTooShort(start: number, end: number): boolean {
  return end > start && end - start < 0.1;
}

export function validateProjectSchema(candidate: unknown): ValidationResult {
  const errors: string[] = [];

  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['Project payload must be a non-null object.'] };
  }

  const proj = candidate as Partial<Project>;

  if (typeof proj.schemaVersion !== 'number') {
    errors.push('Missing or invalid schemaVersion.');
  } else if (proj.schemaVersion !== CURRENT_PROJECT_SCHEMA_VERSION) {
    errors.push(
      `Incompatible schemaVersion: expected ${CURRENT_PROJECT_SCHEMA_VERSION}, found ${proj.schemaVersion}.`
    );
  }

  if (typeof proj.projectId !== 'string' || proj.projectId.trim() === '') {
    errors.push('Missing or empty projectId.');
  }

  if (typeof proj.projectName !== 'string' || proj.projectName.trim() === '') {
    errors.push('Missing or empty projectName.');
  }

  if (typeof proj.sampleRate !== 'number' || proj.sampleRate <= 0) {
    errors.push('Invalid sampleRate.');
  }

  if (!Array.isArray(proj.stems) || proj.stems.length !== 4) {
    errors.push('Project must contain exactly 4 stem definitions.');
  } else {
    const rolesFound = new Set<StemRole>();
    proj.stems.forEach((stem, idx) => {
      if (!stem || typeof stem !== 'object') {
        errors.push(`Stem at index ${idx} is invalid.`);
        return;
      }
      if (!STEM_ROLE_ORDER.includes(stem.role)) {
        errors.push(`Stem at index ${idx} has invalid role "${String(stem.role)}".`);
      } else {
        rolesFound.add(stem.role);
      }
      if (typeof stem.gain !== 'number' || stem.gain < 0 || stem.gain > 1) {
        errors.push(`Stem ${stem.role} has out-of-range gain (${String(stem.gain)}).`);
      }
      if (typeof stem.muted !== 'boolean' || typeof stem.soloed !== 'boolean') {
        errors.push(`Stem ${stem.role} has invalid muted/soloed flags.`);
      }
    });
    if (rolesFound.size !== 4) {
      errors.push('All four required roles (VOCALS, DRUMS, BASS, MELODY) must be present.');
    }
  }

  if (!proj.mixSession || typeof proj.mixSession !== 'object') {
    errors.push('Missing mixSession object.');
  } else {
    const ms = proj.mixSession;
    if (typeof ms.masterGain !== 'number' || ms.masterGain < 0 || ms.masterGain > 1) {
      errors.push('Invalid mixSession.masterGain (must be between 0 and 1).');
    }
    if (typeof ms.loopEnabled !== 'boolean') {
      errors.push('Invalid mixSession.loopEnabled flag.');
    }
    if (
      typeof ms.loopStartSeconds !== 'number' ||
      typeof ms.loopEndSeconds !== 'number' ||
      ms.loopEndSeconds <= ms.loopStartSeconds
    ) {
      errors.push('Invalid mixSession loop boundaries (loopEndSeconds must be > loopStartSeconds).');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
