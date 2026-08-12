export type ContactUrlField =
  'website' | 'instagram' | 'twoGisUrl' | 'bookingUrl';

export function optionalText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed || null;
}

export function trimmedText(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export function normalizedEmail(value: unknown): unknown {
  const text = optionalText(value);
  return typeof text === 'string' ? text.toLowerCase() : text;
}

export function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname.includes('.')
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeInstagram(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const handle = trimmed.replace(/^@/, '');
  if (/^[a-zA-Z0-9._]+$/.test(handle)) {
    return `https://instagram.com/${handle}`;
  }

  const url = normalizeHttpUrl(trimmed);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return hostname === 'instagram.com' || hostname.endsWith('.instagram.com')
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
