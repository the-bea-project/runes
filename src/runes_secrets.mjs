// What a terminal may be named after. A terminal's tab is named after the last command typed
// into it, and what is typed is not always a command: a password, or a token pasted where a
// program asked for one, must never become a name on show. Nothing here touches the page.

// Tokens with a known shape: GitHub, GitLab, Slack, AWS, OpenAI-style keys, JWTs, private keys.
const KNOWN = /(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[\w-]{12,}|xox[abeprs]-[\w-]{10,}|A[KS]IA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;
// Words that say the next thing, or the thing they are joined to, is a secret.
const SENSITIVE = /(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth(?:orization)?|bearer|session[_-]?id|cookie)/i;

/**
 * Whether one word looks like a secret: a token of a known shape, or a long run with no
 * spaces that mixes letters and digits the way a generated key does and a word does not.
 */
export function looksSecret(word) {
  if (KNOWN.test(word)) return true;
  // A path, an address or a flag is long and mixed too, and is not a secret.
  if (word.length < 20 || /^(?:[./~-]|[a-z][a-z0-9+.-]*:\/\/)/i.test(word) || word.includes("/")) return false;
  const body = word.replace(/^[\w.-]+=/, "");
  if (body.length < 20 || !/^[A-Za-z0-9+/_=.-]+$/.test(body)) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((kind) => kind.test(body)).length;
  // Mostly one kind of character is a word or a number; a key has several, with many changes between them.
  let changes = 0;
  for (let i = 1; i < body.length; i++) if (/[0-9]/.test(body[i]) !== /[0-9]/.test(body[i - 1])) changes++;
  return kinds >= 2 && changes >= 4;
}

/**
 * The name a typed line may give a terminal: the line itself, the name of its program alone
 * when something in the line is or may be a secret, or "" when the whole line is one.
 */
export function nameFor(line) {
  const text = String(line ?? "").trim();
  if (!text) return "";
  const words = text.split(/\s+/);
  // One word and nothing else that looks like a key: it was most likely pasted at a prompt.
  if (words.length === 1 && looksSecret(text)) return "";
  if (KNOWN.test(text)) return words.length > 1 && !looksSecret(words[0]) ? words[0] : "";
  const telling = words.some((word, i) => looksSecret(word)
    // `--password hunter2`, `-p hunter2`, `PASSWORD=hunter2`, `Authorization: Bearer …`, `user:pass@host`
    || (i > 0 && SENSITIVE.test(word))
    || /^[A-Za-z_][\w]*=/.test(word) && SENSITIVE.test(word.split("=")[0])
    || /^-p\S+/.test(word)
    || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(word));
  return telling ? words[0] : text;
}

/** Text as a terminal printed it, without the escape sequences that colour and move it. */
export const printed = (data) => String(data).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g, "");

/**
 * Whether a terminal showed a line as it was typed: its characters, in order, somewhere in
 * what was printed. A password is typed and not shown, and that is how it is told from a
 * command. (In order, not side by side: a shell that colours the line as it is typed prints
 * it in pieces.)
 */
export function wasShown(line, shown) {
  const wanted = [...String(line).replace(/\s+/g, "")], seen = String(shown);
  if (!wanted.length) return false;
  let at = 0;
  for (const ch of wanted) {
    at = seen.indexOf(ch, at);
    if (at < 0) return false;
    at += ch.length;
  }
  return true;
}
