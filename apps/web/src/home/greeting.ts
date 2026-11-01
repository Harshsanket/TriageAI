/** Home/chat greeting (Phase 13.T6): app name first, then time of day + name. */
export function greeting(
  name: string | null | undefined,
  now = new Date(),
  timeZone?: string,
  firstVisit = false,
): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hour12: false,
      timeZone,
    }).format(now),
  );
  const clean = name?.trim();
  if (firstVisit && clean) return `Welcome, ${clean}`;
  const base =
    hour >= 5 && hour < 12
      ? 'Good morning'
      : hour >= 12 && hour < 17
        ? 'Good afternoon'
        : hour >= 17 && hour < 22
          ? 'Good evening'
          : 'Welcome back';
  return clean ? `${base}, ${clean}` : base;
}
