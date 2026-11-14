# Security review of Runes 0.7.0

What was checked, what was changed because of it, and what remains. Reviewed against the code
in this repository; the automated checks named below are in `shell/shell.test.cjs` and
`e2e/app.test.cjs`.

## How the app is put together

- **The window** is one sandboxed renderer (`sandbox`, `contextIsolation`, no Node, no
  `webview`). It loads `runes://app/`, served from `dist/`, and nothing from the network.
- **The shell** (`shell/main.cjs`) owns files, terminals, AI requests and extensions. The
  window reaches it only through the named requests in `shell/preload.cjs`.
- **The extension host** is a separate process that runs extension code.

## Checked, and holding

| Risk | Control | Verified by |
|---|---|---|
| Injected script in the window | Content Security Policy sent as a response header and a meta tag: scripts from the app only, no inline script, no network | e2e: an injected inline script does not run; `fetch` to the network fails |
| The window navigating or opening windows | `will-navigate` and `setWindowOpenHandler` deny everything | e2e |
| Another frame or page calling the shell | Every request checks it came from the top frame of `runes://app/` | review |
| Path traversal through `runes://` | Paths are resolved and must stay under `dist/` | review |
| Markup from a language server (hover, messages) | Shown as text, never as HTML | review |
| A VSIX writing outside its folder (zip slip) | Each entry's resolved path must stay inside the extension's folder | unit test |
| A VSIX expanding without limit | Unpacking stops past 600 MB | unit test |
| Silent install of code | An extension with a `main` script needs a native confirmation naming its publisher; declining writes nothing | e2e |
| AI key exposure | The key is encrypted by the OS keychain, read only in the shell, never sent to the window | e2e: the key is absent from the page |
| AI requests to an attacker's server | A custom `runes.ai.baseUrl` must be https, or http on localhost | unit test |
| Update link pointing elsewhere | Only a release URL of the configured repository is accepted; only github.com release links are opened | unit test |
| Options or commands smuggled into git | git runs without a shell; paths must lie inside the open folder and may not start with `-`; hashes must be hex; the commit message goes in on standard input | unit test |
| A branch, tag or commit name used to smuggle an option into git (compare, read an old version, switch branch) | Names must match a strict pattern, cannot start with `-` and cannot contain `..`; git runs without a shell | unit test |
| Switching branch destroying work | `git switch` is run plainly, never with `--force` or `--discard-changes`; git's refusal is shown as it is | unit test, end-to-end |
| A marketplace icon used to load something else into the window | Icons are fetched by the shell, only from the registry's own origin, only as an image type, at most 600 KB, and handed to the page as a `data:` address shown in an `<img>` | unit test |
| A quick fix or extension command changing files behind the user's back | Edits from extensions are applied only to files that are open, as ordinary undoable edits; nothing is written to disk until the user saves | end-to-end |
| Markdown (a file being previewed, or an extension's readme from the marketplace) bringing script or markup into the window | The renderer escapes everything and emits only its own fixed set of tags; HTML in the source is dropped, script and style bodies included. The page's content security policy would refuse inline script regardless | unit test, end-to-end |
| A readme making the window fetch from the network (a tracking picture, say) | Only `data:` pictures are drawn; any other picture becomes its description. The policy allows no remote images | unit test |
| A link in Markdown taking the window somewhere, or opening something unexpected | Links are not `href`s; a click is handed to the shell, which accepts only http(s), shows the whole address, and opens the system browser only if the user agrees | end-to-end |
| A readme fetched from somewhere other than the registry | The shell fetches it, only from the registry's own origin, at most 400 KB, as text | by reading |
| A file passed off as a font, or a font whose name carries style-sheet text | Only `.ttf`, `.otf`, `.woff` and `.woff2` whose first bytes say they are fonts are stored, at most 30 MB each and 80 in all, under their own file name inside the profile's `fonts` folder. The family name is cut down to letters, digits, spaces, dots and dashes before it is used. The bytes are handed to the browser's font loader and to nothing else | unit test, end-to-end |
| Connecting to an impostor over SSH | The machine's key fingerprint is shown the first time and remembered (`ssh-known-hosts.json` in the profile). A different key later is refused before any password or key is offered, and is never asked about; forgetting a key is a separate, deliberate button | unit test, end-to-end |
| SSH passwords and passphrases leaking | They are typed into a hidden field in the window, held in memory for the one sign-in, and written nowhere: not the session file, the settings, or a log | unit test, end-to-end |
| A session's fields, or a file name on the other machine, being read as a command or an option | Host and user are checked against strict patterns and may not start with `-`. Every word sent to the other machine's shell is single-quoted, and the tests use a folder with a quote in its name and a commit message with `$(...)` in it | unit test |
| The window reaching this machine's files through the remote handlers, or the reverse | While connected, workspace paths go to the other machine; only paths inside Runes' own profile folder stay local. Git's checks that a path is inside the folder apply on both | unit test |
| The explorer making, renaming or deleting something outside the open folder | The shell resolves every path it is given and refuses any that is not strictly inside the open folder (the folder itself cannot be renamed or deleted); creating never overwrites, and renaming never replaces an existing file | unit test, end-to-end: the handlers are called from the page with paths outside the folder |
| Deleting by mistake | The shell asks in the window first. On this machine a file goes to the system trash; only if there is none is permanent deletion offered, with a second question. Over SSH the question says there is no trash | end-to-end |
| Discard throwing away the wrong work | Only the named paths, which must lie inside the folder and may not start with `-`; git runs without a shell; the shell asks in the window first, every time | unit test, end-to-end |
| A file name on the other machine read as a command when a folder is removed there | `rm -rf --` with the path single-quoted, after the same inside-the-folder check; without a shell the folder is taken apart over SFTP | unit test |
| Watching for changes used to read outside the folder | Only folders inside the open folder are watched; the page is told which folder or file changed, never file contents | by reading |
| A marketplace download from elsewhere | Extension names are checked, and the file must come from the registry's own address | unit test |
| A half-written settings file | Runes' own files are written to a side file and renamed into place | e2e |
| Mass rewrite by "replace in files" | A native confirmation naming the folder and both strings | review |
| Dependencies | What ships (`npm audit --omit=dev`): 0 known vulnerabilities at the time of this build. The release tooling, which is not shipped, has one moderate advisory: see below | `npm audit` |

## Changed during the review

- The CSP was only a `<meta>` tag; it is now also a response header, which cannot be removed by
  the page.
- `app.enableSandbox()` was added, so any renderer is sandboxed, not just the main window.
- VSIX unpacking gained the size limit above.
- On Linux without a keyring Electron "encrypts" with a fixed password. Runes now refuses to
  store an AI key in that case and says to use `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- Extension storage file names are derived from the manifest and stripped to `[\w.-]`.

## Known and accepted

- **The questions before deleting and discarding are drawn in the window**, like the SSH
  password question, so they protect against a slip of the hand, not against a compromised page: a
  page that could run its own script could answer them itself. Such a page could already
  overwrite any file in the open folder through the save handler, so this adds no new reach;
  and the content security policy is what stops such script from running at all.
- **A moderate advisory in the release tooling.** `minimatch`, pulled in by electron-builder,
  can be made slow by a crafted pattern (GHSA-g3hv-75wg-m249). It runs only when building
  installers, on patterns from this repository's own configuration, and is not part of the
  app. The fix npm offers is an older electron-builder, so it is left until a newer one
  carries the patched version.
- **SSH host keys are kept in Runes' own list, not OpenSSH's `known_hosts`.** A machine you already trust from the command line is asked about once more in Runes. The SSH library (ssh2) and the tests' stand-in server come from the same project; Runes has not been run against a real OpenSSH server by its tests.


- **Extensions run with your privileges.** Same as VS Code: an installed extension can read
  your files and use the network. Runes asks before installing one with code, from a file or
  from the marketplace, but cannot judge it. Nothing built in runs code.
- **Open VSX is a public registry.** Runes does not verify publishers or signatures beyond
  what the registry does. The confirmation names the publisher; check it.
- **Git runs your repository's configuration.** Hooks and configured programs (an editor, a
  pager, a credential helper) are git's, not Runes'. Committing and switching branch run the repository's hooks.
- **No workspace trust.** Opening a folder starts the language servers its files call for, and
  runs `git status` and `git log` in it.
- **The window can read and write any file you can.** It is an editor. The protection is that
  only Runes' own code runs in the window.
- **A terminal is a shell.** Anything able to drive the window can run commands.
- **`@lydell/node-pty` is a beta release** (1.2.0-beta), used because it ships prebuilt
  binaries for Linux, macOS and Windows.
- **Installers are not signed, and Electron fuses and ASAR integrity are not set.** Do both before
  distributing binaries; they also matter before adding self-installing updates.
- **`--no-sandbox`.** Only for running as root (CI). Do not launch Runes that way normally.

## Reporting

Until the project has a repository of its own, report problems to the maintainer directly and
do not open a public issue for anything exploitable.
