# Releasing Runes

One command builds what people download:

    npm run release

It builds the editor (`bea build`, then the bundle in `dist/`), packages it with Electron, and
leaves the results in `release/` with a `SHA256SUMS.txt`. By default it builds for the system
it is run on.

| Command | Makes |
|---|---|
| `npm run release -- --linux` | `Runes-<version>-linux-x64.tar.gz` (with `install.sh`), `…-linux-amd64.deb`, `…-linux-x86_64.AppImage` |
| `npm run release -- --win` | `Runes-<version>-win-x64.exe` (the installer) and `…-win-x64.zip` (portable) |
| `npm run release -- --mac` | `Runes-<version>-mac-<arch>.dmg` and `.zip` |
| `npm run release -- --arch arm64` | the same, for ARM processors |
| `npm run release -- --dir` | only the unpacked app, in `release/<system>-unpacked/`, to try it quickly |
| `npm run release -- --skip-build` | packages `dist/` as it is, without needing `bea` |

Several systems can be asked for at once: `npm run release -- --linux --win`.

## What can be built where

| Built on | Linux files | Windows installer | Windows .zip | macOS files |
|---|---|---|---|---|
| Linux | yes | only with Wine installed | yes | no |
| Windows | no | yes | yes | no |
| macOS | yes | only with Wine installed | yes | yes |

macOS disk images need Apple's tools, so they are made on a Mac. The Windows installer made
on another system needs Wine; without it the script builds the portable `.zip` and says so.
To get everything in one go, use the workflow below: it builds each system's files on that
system.

## All systems at once: the release workflow

`.github/workflows/release.yml` builds the editor once, then makes the installers on Linux,
Windows and macOS runners, and attaches them to a GitHub release.

1. Once: add a repository variable `BEA_URL` holding the address of the Linux `bea` binary
   from <https://github.com/the-bea-project/bea/releases>.
2. Set the version in `package.json`, commit, and push a tag:

       git tag v0.5.0 && git push origin v0.5.0

3. The release appears under Releases with every file and its checksum. The workflow can
   also be run by hand from the Actions tab; the files are then workflow artifacts.

Runes does not look for updates or install them. A new release is taken from the Releases
page and put in place of the old one by hand.

## How each one installs

**Windows.** `Runes-<version>-win-x64.exe` is an installer: it asks where to install (for
you, by default, with no administrator prompt), adds Start menu and desktop shortcuts and an
entry under "Installed apps" to remove it. It registers `runes` with Windows, so `runes` in
the Run box (Win+R) or `start runes` in a terminal opens it. It does not edit `PATH`; to type
plain `runes` in a terminal, add the install folder to `PATH` yourself. The `.zip` needs no
installing: unpack it and run `Runes.exe`.

**macOS.** Open the `.dmg` and drag Runes to Applications.

**Linux.** Three choices:

- `.deb` (Debian, Ubuntu, Mint…): `sudo apt install ./Runes-<version>-linux-amd64.deb`. Installs
  to `/opt/Runes`, puts `runes` on the `PATH`, and adds the menu entry. `sudo apt remove runes`
  takes it away.
- `.tar.gz` (any distribution): unpack it and run the `install.sh` inside.

      tar -xzf Runes-<version>-linux-x64.tar.gz && cd Runes-<version>-linux-x64
      ./install.sh              # for you: ~/.local/opt/runes, `runes` in ~/.local/bin
      sudo ./install.sh         # for everyone: /opt/runes, `runes` in /usr/local/bin
      ./install.sh --uninstall  # with sudo if it was installed with sudo

  It copies the app, links the `runes` command and adds a menu entry; running it again
  upgrades in place.
- `.AppImage`: one file, nothing to install. `chmod +x` it and run it.

## Before publishing

- **Signing.** The builds are not signed. Windows SmartScreen and macOS Gatekeeper warn about
  unsigned apps, and on macOS an unsigned app from the internet must be opened with
  right-click > Open the first time. electron-builder signs when given a certificate
  (`CSC_LINK` and `CSC_KEY_PASSWORD`; on macOS also the notarisation settings); see
  <https://www.electron.build/code-signing>.
- **The icon** comes from `build/icon.png` (1024 px), which electron-builder turns into the
  `.ico` and `.icns` each system wants.
- **The terminal** uses a small native module with a prebuilt copy per system and processor.
  The script fetches the right one when building for a system other than its own.

## Marking a release

The version is in `package.json` (and `bea.toml`, and the bundled theme extension, which
carry the same number). To publish 1.0.0, the first stable release:

    git tag -a v1.0.0 -m "Runes 1.0.0"
    git push origin v1.0.0

Name the release after the tag on the repository's releases page. Add the notes from
`CHANGELOG.md` to it and attach the files from `release/` with their `SHA256SUMS.txt`.
