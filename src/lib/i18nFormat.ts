/**
 * Interpolate `{name}` placeholders in a translation string.
 *
 * Single-pass, with a FIXED regex (never built from caller input): each `{token}`
 * is resolved exactly once against `params`; unknown tokens are left untouched.
 * This avoids the order-dependence and metacharacter hazards of building a regex
 * per param name, and a substituted value that itself looks like a placeholder is
 * never re-substituted.
 */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}
