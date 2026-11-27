/**
 * URL input validation and normalisation.
 *
 * The frontend only checks that the input is a well-formed http(s) address.
 * Network-level protections (SSRF, private ranges, etc.) are the backend's
 * and sandbox's responsibility and are intentionally NOT duplicated here:
 * the demo site itself lives on a bare IP address.
 */

const MAX_LENGTH = 2048;

/**
 * @param {string} input
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function validateUrl(input) {
  const raw = String(input ?? "").trim();

  if (!raw) {
    return { ok: false, error: "Enter a website address to begin." };
  }
  if (raw.length > MAX_LENGTH) {
    return { ok: false, error: "That address is too long." };
  }
  if (/\s/.test(raw)) {
    return { ok: false, error: "Website addresses can’t contain spaces." };
  }

  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  let candidate = raw;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    // "localhost:8080" or "example.com:80" parse as scheme "localhost"/"example.com".
    const looksLikeHostPort = /^[a-z0-9.-]+:\d+/i.test(raw) && !raw.includes("://");
    if (!looksLikeHostPort && scheme !== "http" && scheme !== "https") {
      return { ok: false, error: "Only http:// and https:// addresses are supported." };
    }
    if (looksLikeHostPort) candidate = `http://${raw}`;
  } else {
    candidate = `https://${raw.replace(/^\/\//, "")}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "That doesn’t look like a valid website address." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// addresses are supported." };
  }

  const host = parsed.hostname;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isIpv6 = host.startsWith("[") && host.endsWith("]");
  const isLocal = host === "localhost";
  const hasTld = /\.[a-z0-9-]{2,}$/i.test(host);

  if (!host || (!isIpv4 && !isIpv6 && !isLocal && !hasTld)) {
    return { ok: false, error: "Include the full domain, for example example.com." };
  }
  if (isIpv4 && host.split(".").some((n) => Number(n) > 255)) {
    return { ok: false, error: "That IP address isn’t valid." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Addresses with embedded credentials aren’t accepted." };
  }

  return { ok: true, url: parsed.href };
}

/** Display form of a URL: host + path, without protocol or trailing slash. */
export function displayUrl(url) {
  try {
    const u = new URL(url);
    const path = (u.pathname + u.search).replace(/\/$/, "");
    return u.host + (path === "/" ? "" : path);
  } catch {
    return String(url ?? "");
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Only allow http(s) links to be rendered as anchors. */
export function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
