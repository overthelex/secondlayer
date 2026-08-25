/**
 * Geo Service
 * Multi-signal locale detection:
 * 1. Cloudflare CF-IPCountry header (via backend /api/geo) — fails for VPN users
 * 2. Browser signals (navigator.language, Intl timezone) — works even with VPN
 * 3. Merges both signals, browser wins on conflict (user's actual device settings)
 */
import { API_BASE } from '../../utils/api/base';

const API_URL = API_BASE;

export interface GeoInfo {
  country: string;       // ISO 3166-1 alpha-2 (e.g., "UA", "US")
  language: string;      // Suggested language (e.g., "uk", "en")
  currency: string;      // Suggested currency (e.g., "UAH", "USD", "EUR")
  timezone: string;      // IANA timezone
  source: 'cloudflare' | 'browser' | 'merged';
}

/** Timezones that map to Ukraine */
const UA_TIMEZONES = ['Europe/Kiev', 'Europe/Kyiv', 'Europe/Uzhgorod', 'Europe/Zaporozhye', 'Europe/Simferopol'];

/** Map timezone → likely country */
const TZ_COUNTRY_MAP: Record<string, string> = {
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA',
  'Europe/London': 'GB', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR',
  'Europe/Amsterdam': 'NL', 'Europe/Tallinn': 'EE', 'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ', 'Europe/Bucharest': 'RO', 'Europe/Sofia': 'BG',
  'Europe/Helsinki': 'FI', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH',
  'Europe/Brussels': 'BE', 'Europe/Madrid': 'ES', 'Atlantic/Canary': 'ES', 'Europe/Rome': 'IT',
  'Europe/Lisbon': 'PT', 'Europe/Athens': 'GR', 'Europe/Dublin': 'IE',
  'Europe/Vilnius': 'LT', 'Europe/Riga': 'LV', 'Europe/Zagreb': 'HR',
  'Europe/Ljubljana': 'SI', 'Europe/Bratislava': 'SK', 'Europe/Luxembourg': 'LU',
  'America/Mexico_City': 'MX', 'America/Buenos_Aires': 'AR', 'America/Bogota': 'CO',
  'America/Santiago': 'CL', 'America/Lima': 'PE',
};

const EURO_COUNTRIES = new Set([
  'DE', 'FR', 'NL', 'EE', 'AT', 'BE', 'ES', 'IT', 'PT', 'FI',
  'IE', 'LU', 'SK', 'SI', 'LV', 'LT', 'MT', 'CY', 'GR', 'HR',
]);

function currencyForCountry(country: string): string {
  if (country === 'UA') return 'UAH';
  if (EURO_COUNTRIES.has(country)) return 'EUR';
  if (country === 'GB') return 'GBP';
  return 'USD';
}

class GeoServiceClass {
  private cache: GeoInfo | null = null;

  async detect(): Promise<GeoInfo> {
    if (this.cache) return this.cache;

    // Get browser signals (always available, works through VPN)
    const browserGeo = this.detectFromBrowser();

    // Try Cloudflare detection
    let cfGeo: GeoInfo | null = null;
    try {
      const res = await fetch(`${API_URL}/api/geo`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.country && data.country !== 'OTHER') {
          cfGeo = { ...data, timezone: browserGeo.timezone, source: 'cloudflare' as const };
        }
      }
    } catch {
      // CF detection failed, browser-only
    }

    // Merge: CF takes priority for locale-critical countries (real IP > browser settings),
    // browser takes priority otherwise (resistant to VPN misdetection)
    const CF_PRIORITY_COUNTRIES = new Set([
      'ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'EC', 'VE', 'UY', 'PY',
      'BO', 'CR', 'PA', 'DO', 'GT', 'HN', 'SV', 'NI', 'CU',
    ]);

    let result: GeoInfo;

    if (cfGeo && cfGeo.country === browserGeo.country) {
      // Both agree — high confidence
      result = { ...browserGeo, source: 'merged' };
    } else if (cfGeo && CF_PRIORITY_COUNTRIES.has(cfGeo.country)) {
      // CF detected a locale-critical country — trust IP over browser settings
      result = { ...cfGeo, source: 'cloudflare' };
    } else if (browserGeo.country !== 'OTHER') {
      // Browser has a specific country signal (from timezone/language) — trust it
      result = { ...browserGeo, source: 'browser' };
    } else if (cfGeo) {
      // Browser is generic, CF has data — use CF
      result = { ...cfGeo, source: 'cloudflare' };
    } else {
      // No strong signal from either
      result = browserGeo;
    }

    this.cache = result;
    return result;
  }

  private detectFromBrowser(): GeoInfo {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const browserLang = navigator.language || 'uk-UA';
    const langCode = browserLang.split('-')[0].toLowerCase();

    // Detect country from timezone
    let country = 'OTHER';
    if (UA_TIMEZONES.includes(timezone)) {
      country = 'UA';
    } else if (TZ_COUNTRY_MAP[timezone]) {
      country = TZ_COUNTRY_MAP[timezone];
    }

    // If timezone didn't help, check language subtag (e.g., "uk-UA" → "UA")
    if (country === 'OTHER') {
      const parts = browserLang.split('-');
      if (parts.length >= 2) {
        const region = parts[parts.length - 1].toUpperCase();
        if (region.length === 2) country = region;
      }
    }

    // Language: match browser language to supported locales
    let language: string;
    if (langCode === 'uk' || country === 'UA') {
      language = 'uk';
    } else if (langCode === 'es' || country === 'ES') {
      language = 'es';
    } else {
      language = 'en';
    }

    return {
      country,
      language,
      currency: currencyForCountry(country),
      timezone,
      source: 'browser',
    };
  }

  clearCache() {
    this.cache = null;
  }
}

export const geoService = new GeoServiceClass();
