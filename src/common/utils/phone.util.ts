export function normalizePhone(phone: string): string | null {
  const candidate = extractWhatsAppPhone(phone) ?? phone;
  const match = candidate.match(/(?:\+?7|8)[\s()-]*\d(?:[\s()-]*\d){9}/u);
  if (!match) return null;
  const normalized = match[0].replace(/\D/g, '');

  if (/^8\d{10}$/.test(normalized)) {
    return `+7${normalized.slice(1)}`;
  }

  if (/^7\d{10}$/.test(normalized)) {
    return `+${normalized}`;
  }

  return null;
}

export const normalizeWhatsAppPhone = normalizePhone;

function extractWhatsAppPhone(value: string): string | null {
  try {
    const candidate = /^https?:\/\//iu.test(value.trim())
      ? value.trim()
      : `https://${value.trim()}`;
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./u, '');
    if (host === 'wa.me')
      return url.pathname.split('/').filter(Boolean)[0] ?? null;
    if (host === 'api.whatsapp.com' || host.endsWith('.whatsapp.com'))
      return url.searchParams.get('phone');
  } catch {
    return null;
  }
  return null;
}
