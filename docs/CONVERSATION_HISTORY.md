# Bereinigter Gesprächsverlauf

Stand: 22. Juli 2026

Dieses Dokument hält die Produktentscheidungen und Arbeitsaufträge aus der Entstehung des Meeting Journals fest. Automatisch gelieferte Browser- und Systeminformationen wurden weggelassen. API-Key-Werte, Zugangsdaten, Tokens und andere Geheimnisse sind ausdrücklich nicht enthalten.

## 1. Grundidee

**Nutzer:** „Erstelle mir eine lokale Anwendung, die eine Art Notizbuch/Journal ist, aber immer automatisch die Transkripte meiner Teams-Meetings im Journal speichert und darüber eine Zusammenfassung inklusive Todos anzeigt. Es soll aber auch möglich sein, manuell ein Transkript reinzukopieren/hochzuladen.“

**Ergebnis:** Eine lokale Node.js-Webanwendung mit Journal, manueller Texteingabe, Datei-Upload, Zusammenfassungen, Entscheidungen und Aufgaben wurde aufgebaut.

## 2. Microsoft-Anmeldung

**Nutzer:** „Können wir das nicht mit einer Login-Maske machen? Ohne Entra-Env?!“

**Nutzer:** „Geht keine Anmeldung mit dem einfachen Windows-/Office-Account?“

**Ergebnis:** Die Anmeldung wurde in die Oberfläche verlegt. Sie verwendet den Microsoft Authorization-Code-Flow mit PKCE und benötigt kein Client-Secret oder Microsoft-Zugangsdaten in einer `.env`-Datei. Eine Microsoft-App-Registrierung mit Client-ID bleibt technisch erforderlich, weil Microsoft Graph nur registrierte Anwendungen akzeptiert.

## 3. OneDrive-Ordnerüberwachung

**Nutzer:** „Okay, dann mach parallel bitte noch das mit dem OneDrive-Ordner rein, also die Überwachung.“

**Ergebnis:** Ein lokal synchronisierter OneDrive-, `Recordings`- oder `Aufzeichnungen`-Ordner kann überwacht werden. Unterstützte Transkriptdateien werden beim Start, bei Dateisystemänderungen und zusätzlich regelmäßig geprüft. Dubletten werden erkannt und geänderte Dateien aktualisieren vorhandene Journal-Einträge.

## 4. Zentrales Einstellungsmenü

**Nutzer:** „Bitte auch noch ein Settings-Menü, in dem ich dann den OpenAI API-Key eintragen kann. In die Settings sollten auch die ganzen Interface-Sachen reinkommen, also Teams verbinden, Ordner auswählen usw.“

**Ergebnis:** Ein zentrales Einstellungsfenster mit den Bereichen „KI & Zusammenfassung“, „Microsoft Teams“ und „OneDrive-Ordner“ wurde ergänzt. Optional kann lokal ein OpenAI API-Key gespeichert, getestet und wieder entfernt werden. Ohne API-Key bleibt die lokale Zusammenfassung aktiv.

## 5. Nativer Ordnerdialog

**Nutzer:** „Der Ordner sollte nicht per manuellem Pfad eingegeben werden müssen, sondern über ein Selektorfenster.“

**Ergebnis:** Die Texteingabe für Ordnerpfade wurde durch „Ordner auswählen …“ ersetzt. Die lokale App öffnet den nativen Ordnerdialog von macOS, Windows beziehungsweise Linux und übernimmt die Auswahl intern.

## 6. Manueller Sofort-Scan

**Nutzer:** „Bitte einen ‚Jetzt prüfen‘-Button im Main Interface hinzufügen.“

**Ergebnis:** Im Kopfbereich der Hauptoberfläche gibt es nun „Jetzt prüfen“. Der Button scannt den überwachten OneDrive-Ordner sofort, importiert Änderungen und zeigt das Ergebnis an. Ist noch kein Ordner eingerichtet, öffnet sich der passende Einstellungsbereich.

## 7. Veröffentlichung

**Nutzer:** „Push to Git, add description and labels, add also history of this conversation (exkl. API key).“

**Ergebnis:** Dieser bereinigte Verlauf wurde ergänzt. Laufzeitdaten, Journal-Inhalte, Microsoft-Tokens, lokale Einstellungen und API-Key-Werte bleiben durch `.gitignore` vom Repository ausgeschlossen.

