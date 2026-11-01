/** Need-to-know field projection (Phase 18.8/18.T31). */
export function projectFields<T extends Record<string, unknown>>(
  record: T,
  requiredFields: string[],
): Partial<T> {
  const projected: Partial<T> = {};
  for (const field of requiredFields) {
    if (field in record) projected[field as keyof T] = record[field] as T[keyof T];
  }
  return projected;
}

/** Drop fields a task did not declare, even when the class would allow them. */
export function stripSensitiveFields(
  record: Record<string, unknown>,
  requiredFields: string[],
): Record<string, unknown> {
  return projectFields(record, requiredFields);
}
