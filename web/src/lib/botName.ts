/**
 * Format a bot slug for display.
 *
 * Short role abbreviations (ceo, pm, cro, cmo, seo, api, ux — up to 3 chars)
 * render UPPERCASE: matches how the gawkbot app treats short bot identifiers.
 *
 * Longer slugs (operator, planner, builder, reviewer, eng-1) render Title Case:
 * "Operator", "Planner", "Eng-1".
 *
 * Example:
 *   formatBotName('ceo')      -> 'CEO'
 *   formatBotName('operator') -> 'Operator'
 *   formatBotName('eng-1')    -> 'Eng-1'
 */
export function formatBotName(slug: string): string {
  if (!slug) return "";
  if (slug.length <= 3) return slug.toUpperCase();
  return slug
    .split("-")
    .map((part) =>
      part.length === 0
        ? part
        : part[0].toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("-");
}
