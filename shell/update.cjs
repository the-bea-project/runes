// Looking for a newer Runes: the latest release of one GitHub repository.
"use strict";

// The repository releases are published in, as "owner/name". Empty turns the check off.
const REPOSITORY = "";

/** Is version `a` newer than `b`? Both like "1.2.3", with or without a leading "v". */
function newer(a, b) {
  const parts = (v) => String(v).replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** The newer release, as { version, url }, or null. Never throws. */
async function check(current, repository = process.env.RUNES_UPDATE_REPOSITORY || REPOSITORY, fetcher = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "runes-editor" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const release = await response.json();
    const version = String(release.tag_name ?? "").replace(/^v/, "");
    const url = String(release.html_url ?? "");
    // Only ever send the user to the releases of that same repository.
    if (!version || !url.startsWith(`https://github.com/${repository}/releases/`)) return null;
    return newer(version, current) ? { version, url } : null;
  } catch {
    return null;
  }
}

module.exports = { check, newer, REPOSITORY };
