export function normalizePhone(phone: string): string | null {
  const normalized = phone.trim().replace(/[\s()-]/g, '');

  if (/^8\d{10}$/.test(normalized)) {
    return `+7${normalized.slice(1)}`;
  }

  if (/^7\d{10}$/.test(normalized)) {
    return `+${normalized}`;
  }

  if (/^\+7\d{10}$/.test(normalized)) {
    return normalized;
  }

  return null;
}
