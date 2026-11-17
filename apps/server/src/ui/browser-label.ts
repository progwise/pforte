/**
 * A short name for a browser, made from what it says about itself: "Safari, iPhone". It is how a person tells
 * their browsers apart in a list: the one a passkey was created with (a synced passkey also works elsewhere), a
 * remembered device, where a sign-in came from. Undefined for a browser that says nothing we know.
 */
export const browserLabel = (userAgent: string | undefined) => {
  if (!userAgent) return undefined
  const system = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Macintosh|Mac OS X/.test(userAgent)
            ? 'Mac'
            : /CrOS/.test(userAgent)
              ? 'ChromeOS'
              : /Linux/.test(userAgent)
                ? 'Linux'
                : undefined
  // Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
  const browser = /Edg(e|A|iOS)?\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : undefined
  return [browser, system].filter(Boolean).join(', ') || undefined
}
