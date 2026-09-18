# In ein GitHub-Repository hochladen (einmalig, ca. 5 Minuten)

Das Projekt liegt als Git-Repository mit vollständiger Historie vor (`verve-sales.bundle`) bzw. als Quellcode-ZIP.

1. Auf github.com anmelden → oben rechts „+“ → „New repository“. Name z. B. `verve-sales`, Sichtbarkeit **Private**. Keine Haken bei README/.gitignore/Lizenz setzen. „Create repository“.
2. Git auf dem Rechner installieren, falls nicht vorhanden: https://git-scm.com/download/win
3. In einer Eingabeaufforderung (PowerShell) im Ordner, in dem `verve-sales.bundle` liegt:
   ```powershell
   git clone verve-sales.bundle verve-sales
   cd verve-sales
   git remote set-url origin https://github.com/<IHR-KONTO>/verve-sales.git
   git push -u origin main
   ```
   Beim ersten Push fragt Git nach der Anmeldung (Browserfenster von GitHub öffnet sich).
4. Damit Claude künftig direkt pushen kann: im Browser https://claude.ai/code öffnen (gleiches Konto wie in der App). Beim Anlegen einer neuen Aufgabe in der Repository-Auswahl „GitHub verbinden“ wählen, die Claude-GitHub-App installieren und ihr Zugriff auf `verve-sales` geben. Anschließend eine neue Aufgabe mit diesem Repository starten. (Die Verknüpfung liegt nicht in den Datei-Einstellungen oder Konnektoren der Desktop-App. Fehlt die Option, muss ein Organisations-Admin sie freischalten.)

Alternative ohne Bundle: ZIP entpacken, im Ordner `git init -b main`, `git add -A`, `git commit -m "Etappe 0/1"`, dann Schritt 3 ab `git remote add origin …`.
