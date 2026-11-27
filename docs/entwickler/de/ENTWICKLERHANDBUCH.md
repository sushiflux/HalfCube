---
title: "HalfCube"
subtitle: "Entwicklerhandbuch"
tagline: "Aufbau, Bau und Konventionen für Entwickler"
status: "Entwurf"
copyright: "© 2026 SushiFlux"
lang: "de"
---

# 1 Über dieses Handbuch

HalfCube befindet sich in früher Entwicklung. Dieses Handbuch ist noch unvollständig und wächst mit dem Code. Bisher beschreibt es die Update-Funktion des Windows-Programms.

# 2 Update-Funktion (Windows-Programm)

Die Update-Funktion gibt es nur im Windows-Programm. Die Browser-Version hat keinen Updater. Sie nutzt von dieser Funktion nur „Was ist neu“.

## 2.1 Überblick

| Teil | Ort | Aufgabe |
|---|---|---|
| Update-Dienst | `desktop/src/updates/service.ts` | Hält den einen Update-Zustand des Programms im Hauptprozess und führt die Übergänge aus. Sucht nie von selbst. |
| Velopack-Adapter | `desktop/src/updates/velopack-adapter.ts` | Einzige Datei, die das npm-Paket `velopack` lädt. Hinter der Schnittstelle `VelopackAdapter`, damit der Dienst mit einer Attrappe getestet wird. |
| Update-Quelle | `desktop/src/updates/feed.ts` | Wählt GitHub-Releases oder, für Tests, einen lokalen Ordner oder Server. |
| Versionsabbildung | `desktop/src/updates/version-map.ts` | Bildet die dreiteilige Paketversion auf die fünfteilige Kennung ab. |
| IPC | `desktop/src/updates/updates-ipc.ts`, `desktop/src/preload.ts` | Fünf Kanäle zwischen Seite und Hauptprozess. |
| Vertrag | `app/src/updates/types.ts` | Gemeinsame Typen und Kanalnamen. |
| Oberfläche | `app/src/updates/` | Controller, Zeitplan, Info-Symbol, Update-Karte, Update-Fenster, „Was ist neu“, „Alle Änderungen“, Hinweis bei gescheitertem neuerem Update. |
| Start | `installer/app/entry.cjs` | Velopack-Hooks zuerst, dann das Hauptprogramm. |

Der Hauptprozess besitzt Velopacks `UpdateManager` und den Zustand. Die Seite entscheidet, wann gesucht wird (Einstellung und Zeitpunkt der letzten Suche liegen in ihren Einstellungen), zeigt den Zustand und fordert den nächsten Schritt an.

## 2.2 Zustandsautomat

`UpdateState` ist entweder `{ supported: false, reason }` (`dev-build`, `not-installed`, `portable`) oder `{ supported: true, channel, phase, checking }`. Die Phasen:

`none` → `up-to-date` | `available` → `downloading` → `ready` ⇄ `on-exit`; Fehler: `check-failed`, `download-failed`.

- Eine Suche, die ein Update findet, setzt `available` und startet den Download sofort (wie Autodesk Fusion). `available` sieht die Seite daher selten.
- Ein Download läuft nie parallel zu einer Suche. Eine Suche während des Downloads liefert nur den Zustand.
- Ein neueres Update, das bei `ready` oder `on-exit` gefunden wird, ersetzt das geladene und wird ebenfalls geladen. Der Wunsch „beim Beenden installieren“ geht auf das neuere über. Scheitert der Download des neueren, bleibt das ältere (und seine Vormerkung) erhalten. Die Phase `ready` oder `on-exit` trägt dann `newerDownloadFailed` (Angebot und Fehler). `download` liest zuerst die Quelle neu (gemeinsame Suche, `sharedCheck`), weil Velopacks Objekt aus der früheren Suche Prüfsumme und Dateiliste von damals trägt und ein inzwischen repariertes Release damit wieder scheitern würde. Danach gelten dieselben Regeln wie nach jeder Suche (`applyFound`): ein repariertes Update wird mit dem frischen Objekt geladen, ein noch neueres stattdessen; ist das neuere Update nicht mehr neuer als das bereite, entfällt der Vermerk, und das bereite bleibt. Velopack meldet dabei weiter die schon bereite Version; der Vermerk fällt trotzdem weg, und das prüft jede Suche, nicht nur die Wiederholung. Aus `download-failed` ohne bereites Update wird bei einem zurückgezogenen Update `up-to-date`. Ist die Quelle nicht lesbar, bleibt die Phase und trägt `HC-UPDATE-001` (`retryCheckFailed`); ein bereites Update bleibt bereit. Ein Aufruf während einer Suche oder eines Downloads schließt sich dieser an.
- Nur eine von Hand ausgelöste Suche (`check(true)`) führt zu `check-failed`. Eine automatische bleibt stumm (nur Log). Ein bekanntes Update ersetzt `check-failed` nie.
- Ein beim Start vorgefundenes, früher geladenes Paket erscheint sofort als `ready`.
- Prüfsummenfehler erkennt der Dienst am Wortlaut von Velopacks Fehlertext (`HC-UPDATE-002`), andere Downloadfehler sind `HC-UPDATE-003`. `001` ist die Suche, `004` das Anwenden. Jeder Fehler trägt `detail` (englisch, unübersetzt), Zeitpunkt und Kanal.
- Eine Suche bricht nach 10 s ab (`DEFAULT_CHECK_TIMEOUT_MS`).

`restartNow()` ruft `waitExitThenApplyUpdate(…, silent, restart=true)` und beendet das Programm. `onBeforeQuit()` (am `before-quit` des Hauptprozesses) übergibt ein vorgemerktes Update ohne Neustart.

## 2.3 IPC-Vertrag

Kanäle (`app/src/updates/types.ts`), alle mit Präfix `halfcube:updates-`:

| Kanal | Richtung | Inhalt |
|---|---|---|
| `get` | Seite → Haupt | aktueller `UpdateState` |
| `state` | Haupt → Seite | jeder neue Zustand, auch der Fortschritt (gedrosselt auf 200 ms) |
| `check` | Seite → Haupt | `check(manual: boolean)` → `UpdateCheckResult` |
| `download` | Seite → Haupt | „Erneut versuchen“ nach Fehlschlag (`download-failed`) oder nach gescheitertem neuerem Download (`newerDownloadFailed`); liest die Quelle zuerst neu |
| `restart` | Seite → Haupt | `restartNow()`; erfüllt sich nur mit Fehler |
| `on-exit` | Seite → Haupt | `setInstallOnExit(boolean)` |

`updates-ipc.ts` lässt nur den Hauptframe der eigenen Seite zu (`isTrustedFrame`) und prüft Argumente erneut. `preload.ts` stellt die Schnittstelle als `DesktopBridge.updates` bereit.

## 2.4 Velopack-Einstellungen

- `installer/app/entry.cjs` ruft `VelopackApp.build().setAutoApplyOnStartup(false).run()`. Standardmäßig würde Velopack ein geladenes Paket beim nächsten Start von allein anwenden.
- Die GitHub-Quelle wird mit `prerelease` ausdrücklich gesetzt (`new GithubSource(url, undefined, prerelease)`), für Nightly und Beta `true`.
- `velopack` ist in `vite.desktop.config.ts` als extern markiert und wird erst nach der Prüfung `app.isPackaged` zur Laufzeit geladen.
- Installation pro Nutzer in `%LOCALAPPDATA%\HalfCube`. Nur dort schreibt `Update.exe` ohne Administratorrechte.
- Versionsabbildung (Velopack nimmt nur dreiteiliges SemVer 2): Release `2026.11.12`, Beta `2026.11.12-beta.13.557`, Nightly `2026.11.12-alpha.13.557`. Die Anzeige bleibt fünfteilig. Bei einem Release liest `version-map.ts` die fehlenden zwei Teile aus der ersten gestempelten Überschrift der Release-Hinweise.
- Bekannte Grenze: Die GitHub-Quelle von Velopack liest nur die zehn neuesten Releases des Repositories und filtert danach nach Kanal. Mit mehreren Kanälen im Repository ist vor dem ersten Beta-Tag ein fester Feed je Kanal nötig.

## 2.5 Lokale Tests

Umgebungsvariable `HALFCUBE_UPDATE_FEED` (gelesen in `desktop/src/main.ts`, ausgewertet in `feed.ts`): ein absoluter Pfad eines vorhandenen Ordners mit Velopack-Dateien oder `http://127.0.0.1:<Port>/`. Alles andere wird ins Log geschrieben und ignoriert, dann gilt GitHub.

Test eines Updates über mehrere Versionen hinweg:

1. `scripts/build-installer.ps1 -FeedDir <Ordner> -VersionId v2026.11.20.1.1` bauen.
2. Das mit zwei weiteren, verschiedenen `-VersionId`-Werten wiederholen. Der Ordner wird nicht geleert, `vpk` schreibt Deltas zwischen den Paketen.
3. Das erste Setup installieren und das Programm mit `HALFCUBE_UPDATE_FEED=<Ordner>` starten.

`-VersionId` und `-FeedDir` sind nur für lokale Tests. Mit `-Ci` und bei einem CI-Tag-Bau werden sie abgelehnt. Ein Bau mit `-VersionId` überschreibt die Bündel in `_build`, die die lokale Entwicklungsumgebung nutzt (danach `scripts\dev.ps1 -Neubau`).

Entwicklungsstand: Der Parameter `?updates-demo=…` der Seite zeigt alle Zustände mit erfundenen Daten (`none`, `uptodate`, `found`, `dl`, `ready`, `exit`, `failed`, `faildl`, `newerfail`, `news`). `?updates-demo=newerfail` zeigt ein bereites Update, dessen neueres Update nicht geladen werden konnte (Fehlercode `HC-UPDATE-003`); der Knopf „Erneut versuchen“ gelingt dort. Das Demo-Modul gehört nur zum Kanal `dev` und fehlt in jedem ausgelieferten Bündel (`__HC_UPDATES_DEMO__`).

Tests: `tests/unit/updates/`, `tests/unit/ci/`, `tests/e2e/specs/updates.spec.ts`.

## 2.6 Release-Weg (CI)

Der Release besteht aus zwei Jobs in `.github/workflows/ci.yml`. Beide laufen nur für ein Tag `v*`, nach allen anderen Jobs (`windows`, `web`, `engine-wasm`, `linux`, `ci-ok`). Der Aufbau trennt, wer Fremdcode ausführt, von dem, der schreiben darf: Der Job, der `npm ci` und die Projektskripte ausführt, hat nur Leserechte. Der Job mit Schreibrecht führt nichts aus dem Repository aus.

**Job `release-build`** (Windows, `contents: read`, 60 Minuten):

1. Checkout ohne gespeicherte Zugangsdaten. Das annotierte Tag wird mit dem Lese-Token noch einmal ausdrücklich geholt, weil die Plattformzeile im Tag-Objekt steht.
2. `npm ci`, dann `scripts/ci/release.ts info`: prüft das Tag gegen `version.txt`, liest Kanal und Plattformzeile. Nur `windows-desktop` und `all` werden gebaut; bei anderen Zielen endet der Job ohne Veröffentlichung. Ausgaben: Kanal, Titel (die lesbare Version), Vorabversion, Windows ja/nein.
3. `release.ts body` schreibt den Release-Text (nur der Eintrag dieser Version, Englisch, dann Deutsch; ohne Eintrag ein neutraler Text mit Hinweiszeile im Log; ein Eintrag nur in einer Sprache lässt den Job scheitern). `release.ts excerpt` schreibt Velopacks Release-Hinweise (siehe unten).
4. Die Engine kommt als Artefakt aus dem Job `windows`. `scripts/build-installer.ps1 -Ci` baut das Paket. Zuvor holt `vpk download github` das vorige Paket des Kanals (nur dieses Programm bekommt das Token), damit `vpk pack` ein Delta schreibt. Das Skript legt in `<OutDir>\release` bereit, was veröffentlicht wird: das eigene Setup, die Pakete, eine schlanke `releases.<Kanal>.json` (ohne HTML, nur das Vollpaket trägt Markdown) und `build-result.json`.
5. Hochgeladen werden zwei Artefakte: `release-files` (der Ordner `release`) und `release-text` (nur `body.md`), Aufbewahrung drei Tage.

**Job `release-publish`** (Ubuntu, `contents: write`, 15 Minuten, kein Checkout, kein npm, kein Projektskript):

1. Lädt beide Artefakte herunter. Ohne Token prüft ein eingebettetes Skript alles, was der Updater später liest: Dateimenge, Dateinamen, Größen und SHA-256-Werte gegen den Feed, die Velopack-Version gegen das Tag (die Zuordnung von Tag zu Kanal und Version ist die von `Get-PackVersion` in `build-installer.ps1`; `tests/unit/ci/release-workflow.test.ts` führt dieses Skript gegen Beispieldateien aus). Bei einem Fehler wird nichts veröffentlicht.
2. Mit `gh`: Ein veröffentlichtes Release desselben Tags stoppt den Job, ein Entwurf eines früheren Laufs wird ersetzt. `gh release create --draft` mit den Dateien, dann `gh release edit --draft=false`. Der Updater sieht nie ein halb gefülltes Release.
3. Zum Schluss ruft der Job die Feed-Datei öffentlich ab (bis zu sechs Versuche). Geprüft wird nur, dass sie erreichbar ist. Der Inhalt wurde vorher geprüft.
4. Pro Kanal läuft nur ein Veröffentlichen gleichzeitig (`concurrency`, ohne Abbruch). Ein wartender Lauf je Gruppe: Von drei Tags eines Kanals kurz nacheinander fällt das mittlere weg, dann das Tag erneut schieben.

`vpk upload github` wird nicht benutzt: Es lädt Velopacks nacktes Setup mit hoch und macht die Hinweise des Pakets zum Release-Text. Der einzige Download im Release ist das eigene Setup.

### Release-Hinweise bis zur Größengrenze

Velopacks Release-Hinweise (`NotesMarkdown` des Vollpakets) bauen `buildReleaseNotes` und `releaseNotesExcerpt` in `scripts/ci/release-lib.ts`. Sie bestehen aus dem Rahmen der Kanal-Datei (Titel, Linkzeile, englischer und deutscher Abschnitt) mit den **neuesten Einträgen, so vielen wie in die Grenze passen**. Die Grenze ist `releaseNotesLimit` = 200 KB (Zeichen). Das Programm schneidet Hinweise erst bei 256 KB (`MAX_NOTES_LENGTH` in `desktop/src/updates/service.ts`); der Abstand lässt Platz für den Rahmen, ein Test hält beide Zahlen auseinander. Abgeschnitten wird nur zwischen Einträgen, in beiden Sprachen gleich viele (Halbierungssuche nach der größten passenden Anzahl). Der Eintrag dieser Version und alles Neuere sind immer enthalten, auch wenn das allein über der Grenze liegt (dann eine Warnung im Log). `release.ts excerpt --max-length <n>` ändert die Grenze für einen Lauf. Gibt es keine Kanal-Datei, bleibt der Rahmen mit leeren Abschnitten.

Grund: Der Dialog „Alle Änderungen“ im Update-Fenster liest genau diese Hinweise (Abschnitt 2.7). Die Feed-Datei hält die Hinweise klein, weil jeder Client sie bei jeder Suche für die neuesten Releases liest.

### Datumsstempel im Hook

`scripts/git-hooks/pre-commit` ersetzt in den vorgemerkten Kunden-Changelogs (`CHANGELOG.md`, `CHANGELOG.beta.md`, `CHANGELOG.nightly.md`) die Platzhalter `## vNEXT α`, `## vNEXT β` und `## vNEXT` durch die Version und den **Tag des Commits**, einmal abgerufen (`date '+%Y-%m-%d'`, lokale Zeit). Beispiel: `## vNEXT β · Unraid` wird `## v2026.11.12.13.557 (β) · 2026-11-27 · Unraid`. Der Parser (`app/src/updates/changelog.ts`, `headingDate`) liest das erste Segment nach der Version als ISO-Datum, wenn es ein echtes Datum ist; ein Eintrag ohne Datum zeigt keines. Die Release-CI vergleicht Überschriften mit `headingMatches` (gleich der Version oder beginnt mit der Version, gefolgt von ` · `), das Datum stört dort also nicht.

## 2.7 „Was ist neu“, Update-Fenster und „Alle Änderungen“

Alle Anzeigen lesen Kunden-Changelogs derselben Form (Parser `app/src/updates/changelog.ts`, Regeln in `app/src/updates/news-logic.ts`). Der Parser liest die Datei zweisprachig, nimmt nur den Abschnitt der Oberflächensprache und scheitert nie: Was er nicht versteht, wird übersprungen.

| Anzeige | Datei | Zeigt |
|---|---|---|
| Update-Fenster | `UpdateDialog.tsx` | Nur den Eintrag der angebotenen Version unter „Das ist neu in …“ (`entryOfVersion` auf den Release-Hinweisen des Angebots). Keine Zahl übersprungener Versionen. |
| „Was ist neu“ | `NewsDialog.tsx` | Nur den Eintrag der laufenden Version, mit Kanal-Marke und Tagesdatum (DE `27.11.2026`, EN `2026-11-27`, `formatIsoDate`). Ältere Einträge werden nicht gesammelt. |
| „Alle Änderungen“ | `ChangesDialog.tsx` | Jeden gestempelten Eintrag des Kanals, neuester oben (`allEntries`), mit Version, Datum und nach Bereichen gruppierten Zeilen mit Kategorie-Marken. Ungestempelte „vNEXT“-Einträge fehlen. |
| Link „Alle Änderungen anzeigen“ | `AllChangesLink.tsx` | Öffnet die Webseite oder den Dialog (siehe unten). In „Was ist neu“ mit Quelle `app`, im Update-Fenster mit Quelle `update`. |
| Hinweis bei neuerem Update | `NewerHint.tsx` | Eine Zeile mit Version, Fehlercode, „Details“ und „Erneut versuchen“. |

**Einträge:** `entryOfVersion` liefert den Eintrag einer Version nur, wenn er mindestens eine Zeile außerhalb von „Allgemein“ hat; sonst gilt er als fehlend (Fenster: „Zu dieser Version gibt es keine Beschreibung der Neuerungen“). `decideNewsOnStart` öffnet „Was ist neu“ beim ersten Start nach einem Update, wenn die laufende Version neuer ist als die zuletzt gezeigte und ihr Eintrag eine solche Zeile hat; eine Erstinstallation merkt sich nur die Version. Beim Schließen merkt sich die App die gezeigte Version.

**Quelle von „Alle Änderungen“:** Mit Quelle `app` der mitgelieferte Kanal-Changelog, offline. Mit Quelle `update` und einem vorhandenen Angebot die Release-Hinweise des Angebots (`offer.notesMarkdown`), die dank der Größengrenze (Abschnitt 2.6) die neuesten Kanal-Einträge tragen; ohne Angebot fällt der Dialog auf die mitgelieferte Datei zurück.

**Webseite statt Dialog:** `CHANGELOG_WEBSITE_URL` in `app/src/updates/website.ts` ist heute leer. Ist dort eine https-Adresse eingetragen, öffnet der Link sie im Systembrowser (über `ExternalLink`, das nur https zulässt), und der Dialog wird nicht mehr erreicht. Mehr ist für den Wechsel nicht zu ändern.

**URL-Parameter:** `?changes=app|update` hält den Dialog über ein Neuladen offen (`app/src/screens/main/url-state.ts`, `ChangesSource`); daneben `?news=1` für „Was ist neu“ und `?update=window|restart|error`.

**Hinweis bei neuerem Update:** Phase `ready` oder `on-exit` mit `newerDownloadFailed` (Typ `NewerDownloadFailure`: Angebot und Fehler). `newerFailure(phase)` in `view-model.ts` liefert ihn; `detailError` gibt dessen Fehler an die Detailansicht. In der Update-Karte wächst die Karte dann von 128 auf 168 px, in der Zeile am unteren Rand; im Update-Fenster steht die Zeile über den Knöpfen. „Details“ öffnet die Fehleransicht (`openUpdateError`), „Erneut versuchen“ ruft `startDownload`, im Hauptprozess `download()`: Die Quelle wird zuerst neu gelesen (siehe 2.2). Wird das neuere Update nicht mehr angeboten, verschwindet der Hinweis. Das prüft jede Suche; Velopack meldet dann weiter die schon bereite Version. Ohne Netz zeigt der Hinweis `HC-UPDATE-001`. Das bereite Update bleibt in jedem Fall erhalten.
