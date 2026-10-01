# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionierung nach [SemVer](https://semver.org/lang/de/).

## [0.1.1] – 2026-10-01

### Geändert
- Guard-Bedingungen beim automatischen Laden aufgeteilt (keine funktionale Änderung)

### Behoben
- „Alle anzeigen“ meldet in der Konsole einen Fehler, wenn nicht alle Seiten geladen werden konnten

## [0.1.0] – 2026-09-30

Erste öffentliche Version.

### Hinzugefügt
- Toolbar über der Anbieter-Liste im Immomio-Mieterportal
- Sortierung nach Angeboten, Bewerbungen, Terminen, Aktivität (Summe), Name, „Verbunden seit“, Suchprofil-Status und Originalreihenfolge, jeweils umkehrbar
- Filter: Alle / Mit Angeboten / Mit Bewerbungen / Mit Terminen
- Namenssuche
- „Alle anzeigen“ lädt alle Seiten der Pagination, optional automatisch beim Öffnen
- Einstellungen werden im `localStorage` gespeichert
- Unterstützung für deutsche und englische Oberfläche
