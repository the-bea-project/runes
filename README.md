<p align="center">
  <img src="logo.svg" width="112" height="112" alt="The Runes mark: the rune raidho, cut in mint on black">
</p>

<h1 align="center">Runes</h1>

<p align="center"><b>An elegant, minimal code editor.</b><br><i>Carve your code.</i></p>

<p align="center"><b>1.1.0</b> · Apache-2.0 · Linux, Windows, macOS</p>

Languages, themes, file icons and language servers all come from VS Code extensions (`.vsix`);
Runes has none of its own. Apache-2.0.

Runes ships small. Built in are syntax colouring for about thirty languages (Bea and Gleam
among them), two themes (Runes Void, dark, and Runes Glacier, light) and file icons. Language servers and everything else are installed
from the marketplace or from a `.vsix` file.

## New in 1.1.0: Rune Canvas

Drawings that live in the project, next to the code they explain. A file ending in `.rux`
opens as a board to draw on; `docs/architecture.rux` in this repository is one, of Runes
itself.

- **Start one** with `Rune Canvas: New Drawing…` in the command palette, or `New Drawing…` in
  the explorer's menu. It is a file like any other: it is saved with Ctrl+S, committed,
  compared and travelled through time like the rest.
- **Draw** with the tools along the top, each with a key: select `V`, move the board `H`,
  rectangle `R`, diamond `D`, ellipse `O`, arrow `A`, line `L`, pen `P`, text `T`, eraser
  `E` (or the digits beside them). Shift keeps squares, circles and straight angles. Double
  click to write: on the board, inside a shape, or on an arrow.
- **Arrows hold on.** Drag an arrow's end onto a shape and it is tied there; move the shape
  and the arrow follows.
- **Point at the code.** Give an element a link, such as `src/shop.bea:12`, and Ctrl+click
  on it opens that file at that line. Links stay inside the open folder.
- **Looks**: ten colours that are stored by name and drawn to suit the theme, so one drawing
  reads well in the dark and in the light; three widths; solid, dashed or dotted; a line
  drawn by hand or an exact one.
- **Getting about**: the wheel moves the board, Ctrl+wheel zooms, Space and drag pans,
  Shift+1 fits the drawing to the window, `G` shows a grid that things snap to, `?` lists
  the keys. Tab goes from element to element, and the arrow keys nudge, so a board can be
  worked without a pointer.
- **Out of Runes**: save a drawing as PNG or SVG, or copy it as PNG, from the button at the
  top right. The button beside it shows the file as text.

The file is plain JSON, one element to a line, with usual values left out, so a change to a
drawing is a few changed lines in a diff:

    {
      "rune": "canvas",
      "version": 1,
      "elements": [
        {"id":"shop","type":"rect","x":0,"y":0,"w":160,"h":80,"text":"Shop","fill":"green","link":"src/shop.bea"},
        {"id":"till","type":"ellipse","x":300,"y":0,"w":140,"h":80,"text":"Till"},
        {"id":"a1","type":"arrow","x":166,"y":40,"w":128,"h":0,"from":"shop","to":"till","text":"asks"}
      ]
    }

Element types are `rect`, `diamond`, `ellipse`, `line`, `arrow`, `draw` and `text`. Where the
board is moved to and how far it is zoomed are not written to the file, so looking at a
drawing never changes it.

Not in this release: rotation, grouping, pictures inside a drawing, arrows with bends, and a
handwriting font (text is set in the editor's interface font).

## 1.0.0: the first stable release

Runes 1.0.0 is the first release meant to be relied on. From here on versions follow
[semantic versioning](https://semver.org): settings, key bindings, the pie menu's format and
the files Runes keeps in its profile folder stay compatible within 1.x, and anything that has
to break waits for 2.0. [CHANGELOG.md](CHANGELOG.md) has every release.

What 1.0.0 adds to 0.7.0:

- **Completion as a language server means it.** The list now works the way VS Code's does,
  for any language:
  - every item is matched from where the server says its text starts, against the server's
    own filter text, so `io.prin` finds `io.println`, `int.` lists what `int` has, and a
    module path keeps its list through the `/`;
  - the server is asked as you start a word and at the characters it names as triggers, not
    only once other words happen to match, so types and imported names turn up;
  - the list scrolls, and no longer stops at a dozen; ties go by the server's order;
  - an item's other edits are made with it, so taking a function from a module that is not
    imported adds the import (the cursor stays where it was writing); servers that work
    those out only when an item is taken are asked then;
  - what the chosen item is for is shown beside the list, as rendered Markdown;
  - the same snippet from two extensions is offered once, Backspace keeps the list, and
    words of the file step aside once a server has answered.
- **Hovers are drawn.** What a server says about a name is rendered as the Markdown it is:
  headings, lists, links, and code coloured as the file's language.
- **The light bulb.** When an extension has something to offer for the line the cursor is on
  (a fix, a refactoring, a source action), a bulb appears at the line. Click it, or press
  `Ctrl+.`, for the list; each entry says what kind it is, and the server's preferred fix
  comes first. Actions whose edit is worked out only when chosen are resolved then.
- **Blame.** The status bar says who last changed the line the cursor is on, and how long
  ago, with the commit's subject beside it. It follows unsaved edits (a line just typed is
  "Not committed yet"), a click opens what that commit changed, and
  `git.blame.statusBarItem.enabled` turns it off.
- **Signed commits.** When git signs a commit and the key needs a passphrase, Runes asks for
  it in the window, hands it to git and keeps nothing. GPG keys and SSH signing keys both
  work; a system that shows its own passphrase window, or an agent that already holds the
  key, is left to do so.
- **Git settings.** Settings has a Git section for your name and email, whether commits are
  signed, with what kind of key, and which key, for one repository or for all. These are
  git's own settings, so the terminal sees the same. The gear in Source Control goes there,
  and a commit that fails for want of a name or a key says so in plain words.
- **A language's own icon.** An extension can give its language an icon
  (`contributes.languages[].icon`). Runes now uses it for files the icon theme has nothing
  particular for, so `.bea` files carry Bea's icon out of the box.
- **Marketplace pictures.** Many icons never appeared because the registry's file store calls
  them "a download" rather than "a picture". Runes now goes by the bytes, and keeps each
  picture on disk once fetched, so the list fills at once the second time.
- **Commits by their short names.** A session's two fields show `57da4bc^` and `57da4bc`
  rather than forty letters each, so "the one before it" is no longer pushed out of sight.
- **No AI chat.** It was removed, with its settings, its stored key and its network access.
  Runes now talks to the network for three things only: the marketplace, the update check
  and the machines you connect to over SSH. It may come back when it can do more than chat.

## New in 0.7.0

- **The explorer makes, renames and deletes.** Buttons over the tree and a right click on any
  file or folder: New File, New Folder, Rename, Delete, Copy Path, Show in the File Manager.
  Names are typed in place, and a name like `notes/today.md` makes the folders on the way.
  Renaming an open file keeps its tab, its text and its unsaved edits. Deleting asks first and
  moves to the trash (over SSH there is no trash, and the question says so). All of it is in
  the command palette too, and works the same on a machine reached over SSH.
- **The explorer follows the disk.** Files and folders made, renamed or removed by other
  programs appear and disappear by themselves, open files that have no unsaved edits are read
  again when they change, and source control is asked again. Only the folders the tree has
  open are watched, so a large project costs nothing until it is looked at. Over SSH the open
  folders are checked every few seconds, in one round trip.
- **Discard in source control.** Each change has a discard button, and Changes has *Discard
  all*: changed files go back to the last commit, deleted files come back, files that were
  never committed are removed. It asks first, every time.
- **SSH: folders open without the wait.** When a folder is shown, the folders inside it are
  listed ahead (one level, a few at a time, skipping the likes of `node_modules`), so opening
  one is answered from what is already known, then checked behind the scenes. See
  [how that compares with VS Code](#what-ssh-sessions-do-not-do-yet).
- **SSH: choose how to sign in.** A session can be set to a password only, a key file only, or
  the agent only. Left on *whatever works*, a key in `~/.ssh` that needs a passphrase is no
  longer asked about when the machine would take a password.
- **Comparisons read as one text.** A session shows a commit's changes inline, removed lines
  then added lines, with the whole width to themselves. *Split* puts old and new side by side
  when that is wanted.
- **Looks.** Runes Glacier's side bar is a clear step darker and file icons are deepened on
  light themes, so they stand out. The pie menu has its own ground and lifted slices, so it
  reads on pitch black. Menus are lifted off the black too and stay inside the window. The
  calendar steps a year with one sign instead of two arrows laid over each other.
- The mark is in the repository root as `logo.svg`.

## New in 0.6.0

- **SSH workbench.** A view in the activity bar keeps named sessions: a machine, who to be on
  it, and a folder to open. Connecting turns the whole window over to that machine: the
  explorer, saving, search, source control (its `git`), the graph, sessions and time travel,
  and new terminals all work there. Nothing is installed on the other machine; Runes speaks
  plain SSH and SFTP to it. Sign-in tries your SSH agent, then your key files, then asks for a
  password or passphrase in the window, and keeps none of it. The first time, the machine's
  key fingerprint is shown to accept; after that a different key is refused. Hosts can be
  added from `~/.ssh/config`. Language servers rest while connected (see below).
- **Time travel.** *Open as it was* in a session, or *Git: Time Travel Through This File*, opens
  a file as it stood at a commit: read-only, coloured, with Older and Newer stepping through
  the commits that changed that file. A session can also list **all files** as they were at
  its commit, not only the ones it changed.
- **Click a gutter mark** to see that change in place (what was committed, what is there now)
  with a Revert button and next/previous change (Alt+F3, Shift+Alt+F3).
- **The calendar goes as far back as the project does.** Click its title for the months of the
  year, again for the years; the double arrows move a year (or ten). Days, months and years
  with commits are lit from the whole history, and picking a day the graph has not loaded
  shows the history as it stood then.
- **Runes Glacier**, a light theme: cool grey-blue surfaces, a cyan accent, white only for
  what should stand out. Runes Void stays the default.
- Started from a terminal, the installed app lets the terminal go at once and prints nothing
  (`runes --wait` stays attached; `runes --version`, `runes --help`).
- A shell that ends closes its terminal. Terminals among the editors can be renamed (double-click
  the tab, or the pencil). The maximise button acts on its own group. The Extensions tabs
  scroll when the side bar is narrow.
- Fixed: a folder that is not a git repository showed every line as added in the gutter.

### What SSH sessions do not do yet

Language servers, and anything else an extension runs, stay on this machine, where they could
not see the other machine's files; so there is no completion or diagnostics while connected.
VS Code solves this by installing a server on the other machine; Runes installs nothing,
which is why any machine that takes SSH works. Search uses the other machine's `grep` and
`find` when it has them and falls back to reading files over SFTP when it does not. Jump
hosts and port forwarding are not there yet.

On speed: VS Code's server lists a folder on the far machine and sends the answer back in one
round trip. Without a server, a listing over SFTP takes three or four, each as long as the
machine is far. Runes makes up for that by listing one level ahead and keeping what it has
seen for a minute, so the wait is paid before a folder is opened rather than when it is. The
first listing after connecting, and a folder with more than a couple of dozen folders inside
it, still wait for the machine.

## New in 0.5.0

- **Several cursors.** Ctrl+Shift+L selects every occurrence of the selected text (or of the
  word under the cursor) and puts a cursor on each. Ctrl+D adds the next occurrence, one press
  at a time. Ctrl+Alt+Up and Down add a cursor on the line above or below, Alt+click adds or
  removes one anywhere, and Escape goes back to one. Typing, deleting, Enter, Tab, the arrow
  keys, cut, copy and paste act at every cursor, and each keystroke is one step to undo. A paste
  of as many lines as there are cursors gives each cursor its own line.
  (Copy Line Down moves from Ctrl+D to Shift+Alt+Down, as in VS Code.)
- **Splitting no longer blanks the editor.** Every group keeps its scroll position when the
  arrangement changes, and a new split opens at the same place in the file.
- **Groups slide** to their new places when you split, close a group, drop a tab on an edge or
  maximise. Turning animations off in Settings turns this off too.
- **Fonts are added to Runes itself.** Settings > Font lists the bundled font and the ones you
  have added with *Add font files…* (`.ttf`, `.otf`, `.woff`, `.woff2`). Runes keeps its own
  copy in the profile, so nothing depends on what a system has installed.
- **Installers and one release command.** `npm run release` builds the downloads: a Windows
  installer, a macOS disk image, and for Linux a `.deb`, an `.AppImage` and a `.tar.gz` with an
  install script. A workflow builds all of them on a tag. See [RELEASING.md](RELEASING.md).

## New in 0.4.0

- **Terminals have names.** A terminal is called after the last command typed into it, until you
  rename it (double-click, the pencil, or *Terminal: Rename*); a name you give stays. The list
  has a filter, and *Terminal: Go to Terminal* searches every terminal by name.
- **Pie menu, as in Kando.** A pick counts anywhere in a slice's direction, however far out. A
  slice can hold a pie of its own: pick it, or keep dragging past it and the submenu opens under
  the pointer, so a whole path is one stroke. The centre steps back. Settings edits the whole
  tree: add, rename, reorder and remove at any depth (`runes.pie.items`, with nested `items`).
- **Runes Void, redone.** Pitch black everywhere, and a wider palette: keywords, declarations,
  functions, types, modules, parameters, properties, numbers, constants and strings each have a
  colour. The theme now sets the terminal's sixteen colours too.
- **Comparisons are syntax coloured**, and have an *Open file* button for the file on disk.
- **Extensions view** has tabs (Installed, Marketplace, Built in). Clicking an extension opens
  its page: picture, details, what it adds, its readme, and the Install or Uninstall button,
  which no longer sit in the list.
- **The explorer shows git's view of each file**: modified, untracked, added and deleted files
  are coloured and lettered, and folders that hold changes are marked.
- **Markdown preview**, built in: Ctrl+Shift+V, or the button at the top right of a Markdown
  file to open it beside the text. It follows your typing. The same renderer draws extension
  readmes. It produces only its own markup: HTML in the source is dropped, pictures are not
  fetched from the network, and a link asks before opening your browser.
- **Files changed by other programs are picked up** when you come back to the window or open
  them again, as long as they have no unsaved edits. Git's state is refreshed then too.
- Removed: the editor backdrop opacity setting. The window is always solid.
- Fixed: tabs of Runes' own views (settings, graph, sessions) turned into empty editors when an
  extension was installed or removed. The active tab now scrolls into view when there are more
  tabs than fit. A slice's command survives being given items and losing them again.

## New in 0.3.0

- **Sessions.** Every commit or comparison you open is a session with its own tab: the files it
  touches on the left, the two versions side by side on the right. Older and Newer walk the
  history inside a session. Sessions are listed in Source Control (and under *Git: Show
  Sessions*) until you close them there, so several commits can be open at once.
- **Compare anything.** *Git: Compare Branches, Commits or Files* takes branch names, tags or
  commit ids on either side; leave the right side empty to compare with your files as they are.
  In the graph, mark one commit and compare another with it. "Two files" compares any two files
  on disk. Clicking a change in Source Control opens it the same way.
- **Switch branches** from the status bar, the Source Control view or the graph. Open files that
  have no unsaved edits are read again; if git refuses because work would be lost, Runes says so
  and forces nothing.
- **Change marks in the gutter.** Lines added (green), changed (blue) and removed (red) since the
  last commit.
- **The graph's side panel** lists the files a commit changed, each opening its diff, in place of
  the raw `git show --stat` text.
- **Quick fixes from extensions** are at the top of the right-click menu and under Ctrl+. ;
  commands that extensions contribute are in the command palette, named by their extension.
- **Terminals** are listed in a scrolling column, and any terminal can be moved among the
  editors, where it is a tab like any other and tiles the same way. It keeps running when moved.
- **Extensions show their own pictures**, installed and in marketplace results.
- One theme ships: Runes Void. Ember, Moss and Birch are gone; any VS Code theme still installs.
- Fixed: Ctrl+A, undo, and the clipboard keys in a text field now act on that field, not on the
  open file. Enter in quick open no longer also types a new line into a file that was already
  open. The settings icon is a gear. The logo no longer shifts a pixel after it appears, and a
  light now traces the rune in place of the pulsing ring.

## New in 0.2.0

- **Source control.** A git view (Ctrl+Shift+G) to stage, unstage and commit, with the branch in
  the status bar. It is built in, not an extension: VS Code's own git support is an extension
  that needs the whole source-control UI API, which Runes does not have.
- **Git graph.** Commits as nodes in coloured lanes, merges, branch and tag labels, a legend, and
  a calendar that jumps to a day's commits. Past eight lanes the colours repeat with a different
  node shape and a dashed line, and the legend shows the same marker, so lanes stay distinct.
- **Settings as a page** (Ctrl+, or the gear). One set of settings for the editor, edited as
  fields. It includes an editor for the pie menu. `settings.json` is still the file behind it.
- **Marketplace.** Search and install from Open VSX inside the Extensions view.
- **Extensions view** reworked: marketplace results, what you installed, and a folded list of
  what is built in.
- **Themes.** Runes Void (near-black) became the default.
- The Bea and Gleam toolkits are no longer bundled; their syntax is. The activity bar's lower
  icons are now just Terminal and Settings, and the status bar no longer repeats the app's name.

## Run it

    npm install        # Electron, the bundler, xterm, node-pty
    npm run build      # bea build, then bundle into dist/
    npm start          # open the editor; `npm start -- ~/code/project` opens a folder
    npm run package    # the app, unpacked, for this machine: release/<system>-unpacked/
    npm run release    # installers and archives, in release/ (see RELEASING.md)

`bea` and `gleam` must be on the PATH to build, and for the Bea and Gleam language servers.

## What is in it

| Area | State |
|---|---|
| Editing | Several cursors; selection, undo/redo, auto-indent, auto-closing pairs, comment toggle, move and copy lines, snippets |
| Languages | Syntax for about thirty languages, from VS Code's own grammar extensions, plus Bea and Gleam. `extensions/bundled.json` lists them |
| Language servers | From installed extensions: diagnostics (squiggles, Problems panel, F8); completion with trigger characters, the server's ranges and filters, documentation and automatic imports; hovers drawn as Markdown; go to definition (F12); format document (Shift+Alt+F); fixes and refactorings under a light bulb and `Ctrl+.` |
| Tiling | Split right and down, drag a tab or a file to an edge to split, drag sashes to resize, maximise a group, side bar on either side, bottom panel |
| Minimap | Blocks rather than letters, a draggable viewport, error and warning marks |
| Search | Find and replace in the file (regex, case, whole word); search and replace across the folder |
| Terminal | Any number, in the panel or as tabs among the editors, named and searchable, running your shell (`terminal.shell` to choose another) |
| Pie menu | Hold the right mouse button, or Ctrl+Shift+Space; slices and submenus are edited in Settings (`runes.pie.items`) |
| Themes | Runes Void (dark) and Runes Glacier (light); any VS Code colour or icon theme can be installed |
| Explorer | New file and folder, rename, delete (to the trash), copy path; follows changes made by other programs; files coloured by how they stand with git |
| Source control | Stage, unstage, discard, commit (signed too), switch branch; blame in the status bar; name, email and signing in Settings; change marks in the gutter; comparison of commits, branches and files, inline or side by side, kept as sessions; time travel through a file; a graph of every branch with a calendar |
| SSH | Named sessions; the explorer, search, source control and terminals on the other machine, with nothing installed there |
| Marketplace | Open VSX, searched and installed from inside the editor |
| Font | EnvyCodeR Nerd Font, bundled (SIL Open Font License) |
| Settings | A settings page (Ctrl+,) over `settings.json`; `keybindings.json` in VS Code's format |
| Zoom | Ctrl+wheel changes the text size; Ctrl+= and Ctrl+- zoom the window |
| Rune Canvas | Drawings as `.rux` files in the project: shapes, tied arrows, labels, links to files, a hand-drawn or exact line; saved as readable JSON; PNG and SVG out |
| Markdown | A built-in preview (Ctrl+Shift+V), also used for extension readmes |
| Updates | Checks the latest GitHub release of one repository and links to it. Set `REPOSITORY` in `shell/update.cjs` |

## Keys

The defaults are VS Code's: Ctrl+P files, Ctrl+Shift+P commands, Ctrl+` terminal, Ctrl+J panel,
Ctrl+B side bar, Ctrl+\ split, Ctrl+Shift+F search, Ctrl+Shift+M problems, Ctrl+, settings,
Ctrl+/ comment, Ctrl+Shift+L all occurrences, Ctrl+D next occurrence, Ctrl+. quick fix, Ctrl+Shift+V Markdown preview, Ctrl+K theme, Ctrl+Shift+I developer tools. Every command is in the palette, and
`keybindings.json` rebinds them.

## Extension compatibility

Runes installs `.vsix` files, from disk or from Open VSX (https://open-vsx.org). Microsoft's
Marketplace allows only Microsoft's own products to use it, so Runes does not; an extension
that is only published there (the Bea toolkit, at the time of writing) is installed from its
`.vsix` file, or can be published to Open VSX as well. What Runes does with an extension:

| Contribution | State |
|---|---|
| `languages`, `grammars` (TextMate), `snippets`, language configuration | Used |
| `themes`, `iconThemes` (font and image icons) | Used |
| `main`: the extension's code | Run in the extension host, with the part of the `vscode` API listed below |
| `configuration` | Defaults are read; your `settings.json` overrides them |
| `commands`, `keybindings`, `menus`, views, debuggers, tasks, webviews | Accepted, not shown or run yet |

The `vscode` API in `shell/exthost/vscode.cjs` is the surface `vscode-languageclient` needs:
documents and their events, diagnostics, the provider registry, configuration, output channels,
`Uri`, `Range`, `Position` and the other value types. Completion, hover, definition and
formatting providers are called by the editor. Every other `register…Provider` is accepted and
kept. An API Runes lacks resolves to a stand-in that does nothing, so an extension that touches
one keeps running rather than failing to load. This is not yet "any VS Code extension": UI
extensions (tree views, webviews, source control, debugging) load but have nowhere to draw.

## Layout of the code

    src/runes/buffer.bea      text as lines; insert, delete, slice, word motion
    src/runes/doc.bea         an open file and every edit made to it
    src/runes/layout.bea      the tree of tiles
    src/runes/keymap.bea      key chords and commands
    src/runes/settings.bea    settings.json
    src/runes/extension.bea   reading a VSIX's package.json
    src/runes/git.bea         the commit graph: lanes and the lines between commits
    src/runes/app.bea         the model and update
    src/runes/view.bea        everything drawn (Lustre)
    src/runes_ffi.mjs         the window's edge: keys, TextMate, minimap and terminal elements
    src/runes_canvas.mjs      Rune Canvas: a drawing as data. Reading, checking, writing, geometry
    src/runes_canvas_view.mjs Rune Canvas: the board, an element of the page
    shell/main.cjs            the Electron shell: one sandboxed window and what it may ask for
    shell/exthost/            the extension host process and its `vscode` module
    shell/files.cjs update.cjs vsix.cjs git.cjs market.cjs ssh.cjs
                              search, update check, VSIX reading, git, Open VSX, SSH
    shell/ask.cjs helpers/    how git, ssh and gpg put their questions to the window
    extensions/               extension sources; bundled.json names the ones that ship.
                              prebuilt/ holds the real Bea and Gleam packages for the tests

The editor itself is Gleam, written in its Bea dialect (`src/runes/*.bea`). The shell and the extension host are JavaScript, because they are
Node and Electron glue and because extensions expect a Node `require("vscode")`.

## Tests

    npm test                           # Bea unit tests, shell and canvas unit tests, extension host test
    xvfb-run -a npm run test:app       # 71 end-to-end checks of the real app (Playwright)
    RUNES_ELECTRON=out/Runes-linux-x64/Runes xvfb-run -a npm run test:app   # the packaged app

`npm run test:app` needs Playwright (`npm i -D playwright`), and `--no-sandbox` is passed
because CI containers run as root. See SECURITY.md for the security review.

## Not yet

- Code folding, bracket matching, word wrap.
- Rename, references, signature help, semantic highlighting (the providers are
  registered by extensions already; the editor does not call them yet).
- Floating windows. Tiles split, resize, maximise and move, but stay inside the one window.
- `.sublime-syntax` grammars. TextMate grammars (`.tmLanguage`, JSON or plist) are supported,
  which is what VS Code extensions ship.
- Git: push, pull, fetch and stash are not there yet. Use the terminal for those.
- The explorer: dragging files between folders, copy and paste of files, and choosing several
  at once.
- Debugger.
- Downloading and installing an update by itself. The check tells you and opens the release.
- Windows and macOS builds have not been run. Nothing in the code is Linux-only, but only the
  Linux x64 build was tested.
- Wide characters and emoji put the caret off by a cell.

## Third-party

`extensions/` holds grammar and theme extensions from microsoft/vscode (MIT, see
`extensions/VSCODE-LICENSE.txt`), the Bea extension (Apache-2.0) and the Gleam extension
(Apache-2.0). EnvyCodeR Nerd Font is under the SIL Open Font License (`web/fonts/`).
