---
title: "HalfCube"
subtitle: "Developer Manual"
tagline: "Structure, build and conventions for developers"
status: "Draft"
copyright: "© 2026 SushiFlux"
lang: "en"
---

# 1 About this manual

HalfCube is in early development. This manual is incomplete and grows with the code. So far it describes the update function of the Windows program.

# 2 Update function (Windows program)

The update function exists only in the Windows program.

## 2.1 Overview

| Part | Location | Job |
|---|---|---|
| Update service | `desktop/src/updates/service.ts` | Holds the program's one update state in the main process and runs the transitions. Never checks by itself. |
| Velopack adapter | `desktop/src/updates/velopack-adapter.ts` | The only file that loads the npm package `velopack`. Behind the interface `VelopackAdapter`, so the service is tested with a fake. |
| Update source | `desktop/src/updates/feed.ts` | Chooses GitHub releases or, for tests, a local folder or server. |
| Version mapping | `desktop/src/updates/version-map.ts` | Maps the three-part package version to the five-part id. |
| IPC | `desktop/src/updates/updates-ipc.ts`, `desktop/src/preload.ts` | Five channels between the page and the main process. |
| Contract | `app/src/updates/types.ts` | Shared types and channel names. |
| UI | `app/src/updates/` | Controller, schedule, info icon, update card, update window, "What's new", "All changes", notice for a failed newer update. |
| Start | `installer/app/entry.cjs` | Velopack hooks first, then the main program. |

The main process owns Velopack's `UpdateManager` and the state. The page decides when to check (the setting and the time of the last check live in its preferences), shows the state and asks for the next step.

## 2.2 State machine

`UpdateState` is either `{ supported: false, reason }` (`dev-build`, `not-installed`, `portable`) or `{ supported: true, channel, phase, checking }`. The phases:

`none` → `up-to-date` | `available` → `downloading` → `ready` ⇄ `on-exit`; errors: `check-failed`, `download-failed`.

- A check that finds an update sets `available` and starts the download at once (like Autodesk Fusion). The page therefore rarely sees `available`.
- A download never runs in parallel to a check. A check during a download only returns the state.
- A newer update found during `ready` or `on-exit` replaces the downloaded one and is downloaded too. The wish "install on exit" carries over to the newer one. If the download of the newer one fails, the older one (and its scheduling) stays. The phase `ready` or `on-exit` then carries `newerDownloadFailed` (offer and error). `download` first reads the source again (shared check, `sharedCheck`), because Velopack's object from the earlier check carries the checksum and file list of that moment and a release repaired since would fail again with it. Then the same rules as after any check apply (`applyFound`): a repaired update is downloaded with the fresh object, an even newer one instead; if the newer update is no longer newer than the ready one, the mark is removed and the ready one stays. Velopack keeps reporting the already ready version; the mark goes anyway, and every check tests this, not only the retry. From `download-failed` without a ready update, a withdrawn update leads to `up-to-date`. If the source cannot be read, the phase stays and carries `HC-UPDATE-001` (`retryCheckFailed`); a ready update stays ready. A call during a check or a download joins it.
- Only a manually started check (`check(true)`) leads to `check-failed`. An automatic one stays silent (log only). A known update is never replaced by `check-failed`.
- A package that an earlier session downloaded and found at start shows as `ready` at once.
- The service recognises a checksum failure by the wording of Velopack's error text (`HC-UPDATE-002`); other download failures are `HC-UPDATE-003`. `001` is the check, `004` applying. Every error carries `detail` (English, untranslated), time and channel.
- A check gives up after 10 s (`DEFAULT_CHECK_TIMEOUT_MS`).

`restartNow()` calls `waitExitThenApplyUpdate(…, silent, restart=true)` and quits the program. `onBeforeQuit()` (on the main process's `before-quit`) hands a scheduled update over without restart.

## 2.3 IPC contract

Channels (`app/src/updates/types.ts`), all prefixed `halfcube:updates-`:

| Channel | Direction | Content |
|---|---|---|
| `get` | page → main | current `UpdateState` |
| `state` | main → page | every new state, also progress (throttled to 200 ms) |
| `check` | page → main | `check(manual: boolean)` → `UpdateCheckResult` |
| `download` | page → main | "Try again" after a failure (`download-failed`) or after a failed newer download (`newerDownloadFailed`); reads the source again first |
| `restart` | page → main | `restartNow()`; resolves only with an error |
| `on-exit` | page → main | `setInstallOnExit(boolean)` |

`updates-ipc.ts` accepts only the main frame of the program's own page (`isTrustedFrame`) and validates arguments again. `preload.ts` exposes the interface as `DesktopBridge.updates`.

## 2.4 Velopack settings

- `installer/app/entry.cjs` calls `VelopackApp.build().setAutoApplyOnStartup(false).run()`. By default Velopack would apply a downloaded package at the next start by itself.
- The GitHub source is created with `prerelease` set explicitly (`new GithubSource(url, undefined, prerelease)`), `true` for nightly and beta.
- `velopack` is marked external in `vite.desktop.config.ts` and loaded at run time, only after the check `app.isPackaged`.
- Install per user in `%LOCALAPPDATA%\HalfCube`. In a folder without write access `Update.exe` would relaunch itself as administrator and trigger a UAC prompt on every update.
- Version mapping (Velopack accepts only three-part SemVer 2): release `2026.11.12`, beta `2026.11.12-beta.13.557`, nightly `2026.11.12-alpha.13.557`. The display stays five-part. For a release, `version-map.ts` reads the two missing parts from the first stamped heading of the release notes.
- Known limit: Velopack's GitHub source reads only the ten newest releases of the repository and filters by channel afterwards. With several channels in one repository, a fixed feed per channel is needed before the first beta tag.

## 2.5 Local tests

Environment variable `HALFCUBE_UPDATE_FEED` (read in `desktop/src/main.ts`, evaluated in `feed.ts`): an absolute path of an existing folder with Velopack files, or `http://127.0.0.1:<port>/`. Anything else is written to the log and ignored; GitHub then applies.

Test of an update across several versions:

1. Build with `scripts/build-installer.ps1 -FeedDir <folder> -VersionId v2026.11.20.1.1`.
2. Repeat with two more, different `-VersionId` values. The folder is not wiped, `vpk` writes deltas between the packages.
3. Install the first setup and start the program with `HALFCUBE_UPDATE_FEED=<folder>`.

`-VersionId` and `-FeedDir` are for local tests only. With `-Ci` and in a CI tag build they are rejected. A build with `-VersionId` overwrites the bundles in `_build` that the local dev environment uses (run `scripts\dev.ps1 -Neubau` afterwards).

Dev build: the page parameter `?updates-demo=…` shows every state with made-up data (`none`, `uptodate`, `found`, `dl`, `ready`, `exit`, `failed`, `faildl`, `newerfail`, `news`). `?updates-demo=newerfail` shows a ready update whose newer update could not be downloaded (error code `HC-UPDATE-003`); the button """Try again""" succeeds there. The demo module belongs to the `dev` channel only and is missing from every shipped bundle (`__HC_UPDATES_DEMO__`).

Tests: `tests/unit/updates/`, `tests/unit/ci/`, `tests/e2e/specs/updates.spec.ts`.

## 2.6 Release path (CI)

The release consists of two jobs in `.github/workflows/ci.yml`. Both run only for a `v*` tag, after all other jobs (`windows`, `web`, `linux`, `ci-ok`). The split separates who runs third-party code from who may write: the job that runs `npm ci` and the project scripts has read access only. The job with write access runs nothing from the repository.

**Job `release-build`** (Windows, `contents: read`, 60 minutes):

1. Checkout without stored credentials. The annotated tag is fetched again explicitly with the read-only token, because the platform line lives in the tag object.
2. `npm ci`, then `scripts/ci/release.ts info`: checks the tag against `version.txt`, reads the channel and the platform line. Only `windows-desktop` and `all` are built; for other targets the job ends without publishing. Outputs: channel, title (the readable version), prerelease, Windows yes/no.
3. `release.ts body` writes the release text (only this version's entry, English then German; without an entry a neutral text with a notice line in the log; an entry in one language only fails the job). `release.ts excerpt` writes Velopack's release notes (see below).
4. The engine comes as an artifact from the `windows` job. `scripts/build-installer.ps1 -Ci` builds the package. Before that, `vpk download github` fetches the channel's previous package (only that program gets the token) so that `vpk pack` writes a delta. The script puts what is published into `<OutDir>\release`: the own setup, the packages, a slim `releases.<channel>.json` (no HTML, only the full package carries Markdown) and `build-result.json`.
5. Two artifacts are uploaded: `release-files` (the `release` folder) and `release-text` (only `body.md`), kept for three days.

**Job `release-publish`** (Ubuntu, `contents: write`, 15 minutes, no checkout, no npm, no project script):

1. Downloads both artifacts. Without a token, an embedded script checks everything the updater will read later: file set, file names, sizes and SHA-256 values against the feed, the Velopack version against the tag (the mapping of tag to channel and version is that of `Get-PackVersion` in `build-installer.ps1`; `tests/unit/ci/release-workflow.test.ts` runs this script against sample files). On any problem nothing is published.
2. With `gh`: a published release of the same tag stops the job, a draft of an earlier run is replaced. `gh release create --draft` with the files, then `gh release edit --draft=false`. The updater never sees a half-filled release.
3. Finally the job fetches the feed file publicly (up to six attempts). Only reachability is checked; the content was checked before.
4. Only one publish per channel runs at a time (`concurrency`, no cancelling). GitHub keeps one waiting run per group: of three tags of one channel pushed in quick succession the middle one is dropped; push that tag again.

`vpk upload github` is not used: it also uploads Velopack's bare setup and makes the package's notes the release body. The only download of the release is the own setup.

### Release notes up to the size limit

Velopack's release notes (`NotesMarkdown` of the full package) are built by `buildReleaseNotes` and `releaseNotesExcerpt` in `scripts/ci/release-lib.ts`. They consist of the frame of the channel file (title, link line, English and German section) with the **newest entries, as many as fit the limit**. The limit is `releaseNotesLimit` = 200 KB (characters). The program cuts notes only at 256 KB (`MAX_NOTES_LENGTH` in `desktop/src/updates/service.ts`); the gap leaves room for the frame, and a test keeps both numbers apart. Cuts fall only between entries, the same number in both languages (bisection for the largest count that fits). The entry of this version and everything newer are always included, even when that alone is over the limit (then a warning in the log). `release.ts excerpt --max-length <n>` changes the limit for one run. Without a channel file the frame stays with empty sections.

Reason: the dialog "All changes" of the update window reads exactly these notes (section 2.7). The feed file keeps the notes small because every client reads it for the newest releases on every check.

### Date stamp in the hook

`scripts/git-hooks/pre-commit` replaces, in the staged customer changelogs (`CHANGELOG.md`, `CHANGELOG.beta.md`, `CHANGELOG.nightly.md`), the placeholders `## vNEXT α`, `## vNEXT β` and `## vNEXT` with the version and the **day of the commit**, fetched once (`date '+%Y-%m-%d'`, local time). Example: `## vNEXT β · Unraid` becomes `## v2026.11.12.13.557 (β) · 2026-11-27 · Unraid`. The parser (`app/src/updates/changelog.ts`, `headingDate`) reads the first segment after the version as an ISO date if it is a real date; an entry without a date shows none. The release CI compares headings with `headingMatches` (equal to the version or starting with the version followed by ` · `), so the date does not get in the way there.

## 2.7 "What's new", update window and "All changes"

All views read customer changelogs of the same shape (parser `app/src/updates/changelog.ts`, rules in `app/src/updates/news-logic.ts`). The parser reads the bilingual file, takes only the section of the UI language and never throws: whatever it cannot understand is skipped.

| View | File | Shows |
|---|---|---|
| Update window | `UpdateDialog.tsx` | Only the entry of the offered version under "What's new in …" (`entryOfVersion` on the offer's release notes). No count of skipped versions. |
| "What's new" | `NewsDialog.tsx` | Only the entry of the running version, with channel badge and day (DE `27.11.2026`, EN `2026-11-27`, `formatIsoDate`). Older entries are not collected. |
| "All changes" | `ChangesDialog.tsx` | Every stamped entry of the channel, newest first (`allEntries`), with version, date and lines grouped by area with category badges. Unstamped "vNEXT" entries are left out. |
| Link "Show all changes" | `AllChangesLink.tsx` | Opens the website or the dialog (see below). In "What's new" with source `app`, in the update window with source `update`. |
| Notice for a newer update | `NewerHint.tsx` | One row with version, error code, "Details" and "Try again". |

**Entries:** `entryOfVersion` returns the entry of a version only if it has at least one line outside "General"; otherwise it counts as missing (window: "There is no description of the new features for this version"). `decideNewsOnStart` opens "What's new" at the first start after an update if the running version is newer than the last one shown and its entry has such a line; a first installation only remembers the version. On closing, the app remembers the version it showed.

**Source of "All changes":** with source `app` the shipped channel changelog, offline. With source `update` and an existing offer, the release notes of the offer (`offer.notesMarkdown`), which carry the newest channel entries thanks to the size limit (section 2.6); without an offer the dialog falls back to the shipped file.

**Website instead of dialog:** `CHANGELOG_WEBSITE_URL` in `app/src/updates/website.ts` is empty today. If an https address is entered there, the link opens it in the system browser (through `ExternalLink`, which allows https only) and the dialog is no longer reached. Nothing else has to change for the switch.

**URL parameters:** `?changes=app|update` keeps the dialog open across a reload (`app/src/screens/main/url-state.ts`, `ChangesSource`); besides it `?news=1` for "What's new" and `?update=window|restart|error`.

**Notice for a newer update:** phase `ready` or `on-exit` with `newerDownloadFailed` (type `NewerDownloadFailure`: offer and error). `newerFailure(phase)` in `view-model.ts` returns it; `detailError` hands its error to the detail view. In the update card the card then grows from 128 to 168 px, with the row at its bottom edge; in the update window the row sits above the buttons. "Details" opens the error view (`openUpdateError`), "Try again" calls `startDownload`, in the main process `download()`: the source is read again first (see 2.2). If the newer update is no longer offered, the notice disappears. Every check tests this; Velopack keeps reporting the already ready version. Without a network the notice shows `HC-UPDATE-001`. The ready update is kept in every case.
