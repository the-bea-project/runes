# Changelog

Runes follows [semantic versioning](https://semver.org) from 1.0.0 on.

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
