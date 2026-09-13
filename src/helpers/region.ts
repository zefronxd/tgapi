/**
 * IP-based region detection for localized results
 */

const countryLanguageMap: Record<string, string> = {
  TN: "ar", DZ: "ar", MA: "ar", EG: "ar", SA: "ar", AE: "ar", KW: "ar",
  QA: "ar", BH: "ar", OM: "ar", JO: "ar", LB: "ar", IQ: "ar", LY: "ar",
  SD: "ar", YE: "ar", SY: "ar", PS: "ar",
  FR: "fr", BE: "fr", CH: "fr", CA: "fr", SN: "fr", CI: "fr", ML: "fr",
  BF: "fr", NE: "fr", TG: "fr", BJ: "fr", CM: "fr", MG: "fr",
  DE: "de", AT: "de",
  ES: "es", MX: "es", AR: "es", CO: "es", PE: "es", VE: "es", CL: "es",
  EC: "es", GT: "es", CU: "es", BO: "es", DO: "es", HN: "es", PY: "es",
  SV: "es", NI: "es", CR: "es", PA: "es", UY: "es",
  PT: "pt", BR: "pt", AO: "pt", MZ: "pt",
  IT: "it", NL: "nl", RU: "ru", BY: "ru", KZ: "ru", TR: "tr",
  JP: "ja", KR: "ko", CN: "zh", TW: "zh", HK: "zh",
  IN: "hi", TH: "th", VN: "vi", ID: "id", PL: "pl", UA: "uk",
  RO: "ro", GR: "el", CZ: "cs", SE: "sv", NO: "no", DK: "da",
  FI: "fi", HU: "hu", IL: "he", IR: "fa", PK: "ur", BD: "bn",
  PH: "tl", MY: "ms",
};

export function getLanguageForCountry(code: string): string {
  return countryLanguageMap[code] || "en";
}

export async function detectRegionFromIP(req: Request): Promise<{ country: string; language: string } | null> {
  try {
    const cfCountry = req.headers.get("cf-ipcountry") || req.headers.get("x-country");
    if (cfCountry && cfCountry !== "XX") {
      return { country: cfCountry, language: getLanguageForCountry(cfCountry) };
    }

    const forwardedFor = req.headers.get("x-forwarded-for");
    const clientIP = forwardedFor ? forwardedFor.split(",")[0].trim() : null;

    if (!clientIP || clientIP === "127.0.0.1" || clientIP.startsWith("192.168.") || clientIP.startsWith("10.")) {
      return null;
    }

    const geoResponse = await fetch(`http://ip-api.com/json/${clientIP}?fields=countryCode`);
    if (geoResponse.ok) {
      const geoData = await geoResponse.json();
      if (geoData.countryCode) {
        return { country: geoData.countryCode, language: getLanguageForCountry(geoData.countryCode) };
      }
    }

    return null;
  } catch {
    return null;
  }
}
