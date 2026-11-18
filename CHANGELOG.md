# Changelog

Runes follows [semantic versioning](https://semver.org) from 1.0.0 on.

## 1.3.0

Editing
- **Ctrl+] and Ctrl+[** move the line, or every line of the selection, a step in and out,
  wherever the cursor is in it. **Ctrl+Shift+K** deletes the line.
- **Alt+Shift+Up and Alt+Shift+Down** put another cursor on the line above or below, one for
  each press, as in VS Code on Linux. Copy Line Down moves to Ctrl+Shift+Alt+Down.
- **Signature help.** While a call's arguments are written, what the function expects is
  shown over the line, with the argument in hand marked and what the server says of it.
  It follows the cursor through the call and closes when the call does, or on Escape.
  `Trigger Parameter Hints` in the palette asks for it.
- **Breadcrumbs**: a line above each editor that says where the file is and which function,
  type or class the cursor is inside. The names come from the language server; without one,
  from how the lines are indented. A name that is clicked is gone to. `breadcrumbs.enabled`,
  or `View: Toggle Breadcrumbs`.
- Suggestions, hovers and signature help are placed against the window, not inside the text.
  A wide list of suggestions no longer gives the editor a sideways scroll bar, breaks the
  wrapping of lines, or scrolls the line numbers out of sight.
- The list of suggestions stays open while characters are typed, and is matched against them.
  It used to be closed on every key and asked for again, and a character that is no part of
  a word, as the slash in `import gleam/`, closed it for good. Escape closes it, and an
  answer still on its way from the server no longer opens it again.

Language servers
- **File watchers are real.** An extension that asks to be told when files change
  (`createFileSystemWatcher`) is now told. This is how a language server hears that a
  manifest changed: a dependency added to `Cargo.toml`, `go.mod` or `pyproject.toml` is
  known without reloading the editor.
- The Bea and Gleam servers do not take a changed manifest in while they run. Runes starts
  them again when `bea.toml` or `gleam.toml` changes, through their extensions' own restart
  command (`runes.restartServersOnManifestChange`, on by default).
- **A module that cannot be found is an error**, whatever level its server reports it at.
  Hints are no longer underlined in blue: a plain hint is a few dots, code that is not
  needed is faded, code that is out of date is struck through, as in VS Code. Hints are not
  listed among the problems, counted, or stopped at by F8.
- A server's first answers are waited for (up to 45 seconds, not 8): the first list of
  suggestions after a server starts no longer goes missing.

Viewers
- **Pictures, sound, film, PDFs, workbooks and CSV open to be looked at.** PNG, JPEG, GIF,
  WebP, BMP, ICO and AVIF; MP3, WAV, OGG, Opus, FLAC, M4A and AAC; MP4, WebM, OGV, MOV and
  MKV, in the engine's own players; PDF in the engine's own viewer; `.xlsx` workbooks and
  CSV or TSV files as tables, with sheets, sorting by a column and any number of rows.
  A CSV file is also text: `Edit as text` and `Show the table` go between the two.

Explorer
- **F2 renames the file in front**, and in the explorer the file that was clicked. It used to
  rename the folder last opened.
- **Ctrl+Z in the explorer brings back what was deleted**, a file or a folder with all that was
  in it, the last twenty deletions, last first. What is not brought back goes to the system's
  trash when Runes closes; so does anything whose place has been taken since. (Where the folder is on another disk than Runes' own data, large
  things go straight to the trash, which can still give them back.)
- Rows of the tree are kept as files and folders appear, go and open around them. Opening
  an empty folder, or anything changing above an open one, no longer redraws what is below.

Tabs
- **A tab dropped on a group's strip of tabs joins that group**; dropped on a tab, it goes in
  before that tab, which also puts the tabs of one group in another order. Before this a tab
  could only be dropped on an editor, where all but the middle makes a new tile.

Terminal
- **A password or a token never becomes a terminal's name.** A terminal is named after the
  last command typed at its shell: not after what was typed into a program the shell runs
  (git asking for a password), not after what was typed and not shown, and not after anything
  that reads as a secret. A command that carries one is named after its program alone.

Rune Canvas
- **Groups.** Several things chosen are made one with Ctrl+G, or from the panel of what is
  chosen, and are then chosen, moved, copied and resized as one. Ctrl+Shift+G takes a group
  apart again. A group can be grouped; Alt and a click chooses one thing inside a group.
- **Writing of any size.** Pull the corner of a piece of writing to make it larger or smaller,
  or step it from the panel; writing in a group is scaled with the group.
- **Lines can be kept from sticking to shapes**: the magnet beside the grid button, or M.
  Alt while dragging holds it off once. The choice is kept between sessions.

Also
- The logo no longer redraws itself when pointed at. Its own slow light stays.

## 1.2.0

Editing
- **Indentation follows the language and the file.** Enter, Tab and Backspace go by the
  language's own rules (`onEnterRules`, `indentationRules` and brackets from its
  configuration, and whatever an extension adds as it runs), so Python indents after a colon
  and steps back after `pass`. Each file is indented the way it already is, tabs or spaces
  and how many; the status bar shows it and a click changes it. `editor.tabSize`,
  `editor.insertSpaces`, `editor.detectIndentation`, and per language (`"[python]": {…}`).
- **Code folding**: a mark beside every block, Ctrl+Shift+[ and Ctrl+Shift+], Fold All and
  Unfold All. **Indent guides**. **Bracket matching**, and Ctrl+Shift+\ to go to the pair.
- **Word wrap** (Alt+Z, `editor.wordWrap`).
- **Ctrl+click goes to the definition**, into a library's own files when that is where it is.
- **Wide characters and emoji** take the room they are drawn in: the caret stands where the
  text is, and steps over a whole character at a time.

Extensions
- **The Python extension works**: completion, hovers, go to definition and its Enter rules,
  through its Jedi language server. (Pylance is Microsoft's and may only run in Microsoft's
  editors; it is not on Open VSX.) Much more of the `vscode` API is there for large
  extensions to start against.
- **Running Extensions**: a page, from the Extensions view, listing every extension with
  code: whether it has started, how long that took, why it failed, and everything it has
  written to its output channels, its console and its errors. The extension host can be
  restarted from there.
- **Extensions can be switched off and on** without uninstalling them.

Explorer
- Several files and folders are chosen with Ctrl and Shift; **copy, cut and paste**; files are
  **dragged between folders** (Ctrl copies); files and folders **dropped in from outside** are
  copied in, as are files copied in the system's file manager; several are deleted at once.

Git
- Runes shows and stages; it no longer commits, switches branch or edits git's settings.
  Those are done in the terminal. Seeing changes, staging, discarding, the graph, sessions,
  blame and time travel are as they were.
- **Merge conflicts** are listed in Source Control and settled in the editor: Accept current,
  Accept incoming or Accept both, above each conflict. Staging the file marks it resolved.

Rune Canvas
- **Lines and arrows bend.** Pull the middle of one and it bends there; pull again between
  two points for another bend. Double click a bend to take it out. Tied ends still follow
  their shapes, and labels sit at the middle of the curve.

Also
- **Runes: Reload** (Ctrl+Alt+R) starts the editor afresh in the same window, with the same
  files open.
- The terminal copies with Ctrl+Shift+C (or Ctrl+C while something is selected) and pastes
  with Ctrl+Shift+V, Ctrl+V or Shift+Insert.
- The check for updates is gone. New releases are on the releases page.
- Fixed: Ctrl+Shift with a punctuation key (Ctrl+Shift+`) was not recognised as a key binding.
- Fixed: blame on a file git does not know (a new one, say) could stop the whole window
  behind an error box. Git going away early is now simply no answer, and an error nothing
  was waiting for is written to the log rather than shown in a box that blocks everything.
- Fixed: a Markdown list item holding a line separator character stalled the preview.
- Fixed: the message that an extension failed to start could be covered at once by the
  message that it was installed.

## 1.1.0

- **Rune Canvas**: drawings kept as files of the project. A `.rux` file opens as a board to
  draw on: rectangles, diamonds, ellipses, arrows, lines, a pen and text, in a hand-drawn or
  an exact line. Arrows tie to the shapes they are dragged onto and follow them. Shapes and
  arrows take labels. An element can point at a file of the project (`src/shop.bea:12`), and
  Ctrl+click opens it there.
- The file is JSON with one element to a line, so changes to a drawing read well in a diff
  and merge like code. Colours are stored by name and drawn to suit the theme, dark or light.
- `Rune Canvas: New Drawing…` in the command palette, `New Drawing…` in the explorer's menu.
  A drawing can be read as text and drawn again, and saved as PNG or SVG, or copied as PNG.
- `docs/architecture.rux` draws how Runes itself is put together.

## 1.0.0

The first stable release.

- Completion follows the language server: its ranges, filter and sort text, trigger
  characters, incomplete lists, documentation beside the list, and the edits that come with
  an item (automatic imports), also when the server names them only on resolve. The list
  scrolls and is no longer cut at twelve; duplicates are shown once.
- Fixed: the server was asked for completions with the text as it was one keystroke earlier.
- Hovers and completion documentation are rendered as Markdown, with coloured code.
- A light bulb on lines where an extension offers a fix or a refactoring; the list under
  `Ctrl+.` names each entry's kind and resolves an action's edit when it is chosen.
- Blame in the status bar: who last changed the line under the cursor, and when. It follows
  unsaved edits, and a click opens the commit. `git.blame.statusBarItem.enabled` turns it off.
- Signed commits: a signing key's passphrase is asked for in the window (GPG and SSH keys).
- Git settings in Settings: name, email, signing, key, for one repository or for all.
- Commit failures are explained: no name or email yet, or the commit could not be signed.
- A language's own icon, from its extension, is used where the icon theme has none. Bea's
  icon ships with Runes.
- Marketplace pictures are recognised by their bytes, so icons the registry serves as plain
  downloads appear; pictures are kept on disk once fetched.
- A session's two fields show commits by their short names, so `^` is in sight.
- Removed: AI chat, its settings (`runes.ai.*`), its stored key and the `Ctrl+Alt+I` binding.
  Old settings files that still hold `runes.ai.*` are read without complaint; the lines are
  ignored.

## 0.7.0

- The explorer makes, renames and deletes files and folders, and follows changes made by
  other programs.
- Discard in source control.
- SSH: folders listed ahead, and a choice of how to sign in.
- Comparisons read as one text, with a Split toggle.
- Glacier's side bar is darker; the pie menu and menus stand clear of pitch black.

## 0.6.0

- SSH workbench: named sessions, the explorer, search, source control and terminals on another
  machine with nothing installed there.
- Time travel through a file's history; a peek at a change from the gutter, with revert.
- Runes Glacier, a light theme. The calendar steps through months and years.
- Runes detaches from the terminal it was started in.

## 0.5.0

- Several cursors. Groups slide when the layout changes.
- Fonts are added to Runes itself rather than read from the system.
- Installers for Linux, Windows and macOS, and one command that builds them.

## 0.4.0

- Named, searchable terminals. Pie submenus, edited as a tree. Runes Void redone on pitch black.
- Extension pages and tabs; files in the explorer coloured by git; a Markdown preview.

## 0.3.0

- Sessions that compare commits, branches and files. Branch switching. Change marks in the
  gutter. Tiled terminals. Quick fixes.

## 0.2.0

- The Open VSX marketplace, the git graph, settings as a page, the pie menu.

## 0.1.0

- The editor, the Electron shell, VS Code extensions (`.vsix`), language servers.
