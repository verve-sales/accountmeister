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
4. Danach in der Claude-App unter Einstellungen → Integrationen GitHub verknüpfen; dann kann Claude in künftigen Sitzungen direkt in dieses Repository pushen.

Alternative ohne Bundle: ZIP entpacken, im Ordner `git init -b main`, `git add -A`, `git commit -m "Etappe 0/1"`, dann Schritt 3 ab `git remote add origin …`.
