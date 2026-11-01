/** Per-class retention planning (Phase 18.8/18.T17). */
import type { DataClass } from '../data/classes.js';

export interface ClassRetentionAction {
  classId: string;
  action: 'delete' | 'keep' | 'legal_hold';
  days?: number;
  reason: string;
}

export function planClassRetention(
  classes: DataClass[],
  args: { now?: Date; legalHolds?: string[] } = {},
): ClassRetentionAction[] {
  const held = new Set(args.legalHolds ?? []);
  return classes.map((cls) => {
    if (held.has(cls.id)) {
      return { classId: cls.id, action: 'legal_hold', reason: 'legal hold' };
    }
    if (cls.retention.mode !== 'days' || cls.retention.days === undefined) {
      return {
        classId: cls.id,
        action: 'keep',
        reason: `mode:${cls.retention.mode}`,
      };
    }
    return {
      classId: cls.id,
      action: 'delete',
      days: cls.retention.days,
      reason: `older than ${cls.retention.days} days`,
    };
  });
}
