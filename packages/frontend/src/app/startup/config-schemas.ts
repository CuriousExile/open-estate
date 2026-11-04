import { isValidLocaleTag } from '@open-estate/shared';
import { z } from 'zod';

const LocaleTag = z.string().refine(isValidLocaleTag, { message: 'must be a valid BCP 47 locale' });

/** `i18n-config.json`: default locale and enabled locales with their labels (design: Konfigurationsmodelle). */
export const I18nConfigSchema = z
  .object({
    defaultLocale: LocaleTag,
    enabled: z.array(z.object({ locale: LocaleTag, label: z.string().trim().min(1) })).min(1),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.enabled.forEach((entry, index) => {
      const key = entry.locale.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['enabled', index, 'locale'],
          message: `duplicate locale "${entry.locale}"`,
        });
      }
      seen.add(key);
    });
    if (!config.enabled.some((entry) => entry.locale === config.defaultLocale)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultLocale'],
        message: `default locale "${config.defaultLocale}" is not enabled`,
      });
    }
  });
export type I18nConfig = z.infer<typeof I18nConfigSchema>;

/** `i18n/{locale}.json`: flat map of translation keys to texts (design: Konfigurationsmodelle). */
export const TranslationSchema = z.record(z.string(), z.string());
export type Translation = z.infer<typeof TranslationSchema>;

/**
 * `runtime-config.json`: deployment-specific values of the SPA (Req 11.1 — nothing hard-coded).
 * `apiBaseUrl` may be absolute (`https://api.example.org`) or relative to the SPA (`/api`).
 */
export const RuntimeConfigSchema = z.object({ apiBaseUrl: z.string().trim().min(1) });
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/** Compact, single-line description of Zod issues for logs and error pages. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ` : '') + issue.message)
    .join('; ');
}
