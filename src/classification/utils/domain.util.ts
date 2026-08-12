export function extractDomains(values: unknown[]): string[] {
  const domains = new Set<string>();

  for (const value of values) {
    if (typeof value !== 'string' || !looksLikeUrl(value)) {
      continue;
    }

    const domain = extractDomain(value);
    if (domain) domains.add(domain);
  }

  return [...domains];
}

export function extractDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('@')) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const hostname = new URL(candidate).hostname
      .toLowerCase()
      .replace(/^www\./, '');
    return hostname.includes('.') ? hostname : null;
  } catch {
    return null;
  }
}

function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes('@')) return false;
  return (
    /^(?:https?:\/\/|www\.)/i.test(trimmed) ||
    /^[a-z\d.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(trimmed)
  );
}
