# Meeting Journal

Eine lokal laufende Journal-Anwendung für Meeting-Transkripte. Sie speichert Transkripte, erzeugt Zusammenfassungen und sammelt Aufgaben an einem Ort.

Der bereinigte Entstehungsverlauf ist unter [docs/CONVERSATION_HISTORY.md](docs/CONVERSATION_HISTORY.md) dokumentiert. Zugangsdaten und API-Key-Werte sind darin nicht enthalten.

## Funktionen

- Manuelles Einfügen von Transkripten
- Datei-Import für TXT, VTT, SRT, Markdown und JSON
- Automatischer Abruf von Teams-Transkripten über Microsoft Graph
- Lokale Zusammenfassung und Aufgaben-Erkennung ohne Cloud-Zwang
- Optionale, präzisere Zusammenfassungen über die OpenAI Responses API
- Suche, Quellenfilter, Entscheidungen und abhakbare Aufgaben
- Ausschließlich lokale Journal-Daten unter `data/journal.json`

## Start

Voraussetzung: Node.js 20 oder neuer.

```bash
npm start
```

Danach `http://127.0.0.1:4173` öffnen. Integrationen werden zentral über **Einstellungen** in der Oberfläche konfiguriert. Eine `.env`-Datei ist nur noch für optionale technische Werte wie einen abweichenden Port nötig.

## Teams automatisch verbinden

Der automatische Import verwendet eine normale Microsoft-Anmeldung direkt in der App. Es gibt kein Client-Secret und keine Microsoft-Zugangsdaten in `.env`. Eine einmalige App-Registrierung bleibt erforderlich, weil Microsoft Graph keine nicht registrierten Anwendungen akzeptiert.

1. Im Microsoft Entra Admin Center eine App registrieren.
2. Unter **Authentication → Add a platform → Single-page application** exakt diese Redirect-URI eintragen: `http://127.0.0.1:4173/`.
3. Unter **API permissions → Microsoft Graph → Delegated permissions** hinzufügen:
   - `User.Read`
   - `Calendars.Read`
   - `OnlineMeetings.Read`
   - `OnlineMeetingTranscript.Read.All`
4. Für `OnlineMeetingTranscript.Read.All` durch einen Administrator **Admin consent** erteilen.
5. Im Teams Admin Center unter **Meetings → Meeting settings → Transcript API access** den Microsoft-Graph-Zugriff aktivieren. Optional die Sprecherzuordnung aktivieren.
6. Im Journal **Einstellungen → Microsoft Teams** öffnen und einmalig die Application (Client) ID eintragen. Als Tenant funktioniert `organizations` oder die konkrete Directory/Tenant-ID.

Die App verwendet den Authorization-Code-Flow mit PKCE. Es muss und darf kein Client-Secret in die Browser-App eingetragen werden. Nach der Anmeldung werden Kalendertermine der letzten 90 Tage geprüft, Teams-Meetings aufgelöst und verfügbare Transkripte importiert. Beim Öffnen sowie alle 15 Minuten wird automatisch synchronisiert, solange die App geöffnet ist.

## Lokalen OneDrive-Ordner überwachen

Als Alternative zur Microsoft-Graph-Anmeldung kann die App einen Ordner überwachen, den die OneDrive-Desktop-App bereits lokal synchronisiert:

1. **Einstellungen → OneDrive-Ordner** wählen.
2. **Ordner auswählen …** anklicken und den lokalen OneDrive- oder `Recordings`-/`Aufzeichnungen`-Ordner im nativen Systemdialog auswählen. Eine manuelle Pfadeingabe ist nicht nötig.
3. **Überwachung aktiv** einschalten und speichern.

Typische OneDrive-Pfade werden automatisch erkannt. Beim Aktivieren werden vorhandene Dateien importiert. Neue oder geänderte Dateien werden anschließend über Dateisystemereignisse und zusätzlich einmal pro Minute erkannt. Unterstützt werden `.vtt`, `.docx`, `.txt`, `.srt`, `.md` und `.json`. Identische Inhalte werden nicht doppelt importiert; eine geänderte Datei aktualisiert ihren bestehenden Journal-Eintrag.

Microsoft speichert Teams-Transkripte in OneDrive for Business beziehungsweise SharePoint. Im Teams-Rückblick können Organisatoren Transkripte als VTT oder DOCX herunterladen. Die Ordnerüberwachung sieht nur Dateien, die durch die OneDrive-App tatsächlich auf dem Computer synchronisiert oder manuell in den überwachten Ordner gelegt wurden.

## Optionale KI-Zusammenfassungen

Ohne API-Key arbeitet die App mit einer lokalen Heuristik. Unter **Einstellungen → KI & Zusammenfassung** kann ein OpenAI API-Key eingetragen, das gewünschte Modell ausgewählt und die Verbindung geprüft werden. Der Schlüssel wird serverseitig in `data/settings.json` mit restriktiven Dateirechten gespeichert, vom Browser nie wieder vollständig abgerufen und von Git ignoriert. Bei einem API-Fehler fällt die App automatisch auf die lokale Analyse zurück.

## Datenschutz

- Journal und Transkripte werden lokal in `data/journal.json` gespeichert.
- Microsoft-Tokens und Client-ID liegen nur im lokalen Browser-Speicher. Ein Client-Secret wird nicht verwendet.
- Der optionale OpenAI-Key liegt ausschließlich in der lokalen, von Git ignorierten Datei `data/settings.json` und wird nie vollständig an den Browser zurückgegeben.
- Bei aktivierter OpenAI-Zusammenfassung wird der Transkripttext zur Analyse an die OpenAI API übertragen.
- Teams-Daten werden nur gelesen. Die App schreibt nichts nach Microsoft 365 zurück.
- Die OneDrive-Ordnerüberwachung liest ausschließlich unterstützte Transkriptdateien im ausgewählten lokalen Ordner; sie verändert oder löscht dort keine Dateien.

## Tests

```bash
npm test
```
