# Erklärvideos neu erzeugen

Die Videos entstehen vollautomatisch aus den Drehbüchern in `scripts.mjs`: Playwright klickt die Abläufe im echten Tool durch (fiktive Daten aus `video-seed.ts`), Piper spricht den Text offline mit einer deutschen Stimme, ffmpeg brennt Untertitel ein und schneidet Titel, Szenen und Abspann zusammen.

Nach Änderungen an der Oberfläche einfach neu erzeugen – Texte und Klickwege stehen in `scripts.mjs`.

## Voraussetzungen (Entwicklungsrechner)

- PostgreSQL lokal, ffmpeg (mit libass), Chromium für Playwright
- `pip install piper-tts`
- Stimme „thorsten-high“ (z. B. aus den sherpa-onnx-Releases auf GitHub: `vits-piper-de_DE-thorsten-high.tar.bz2`, darin `de_DE-thorsten-high.onnx` und `.onnx.json`)

## Ablauf

```bash
createdb -U postgres verve_video
# Entwicklungsserver auf der Video-Datenbank (Entwicklungsanmeldung, Testanbieter-KI)
DATABASE_URL=postgresql://postgres@localhost:5432/verve_video AI_PROVIDER=test npx next dev -p 3200

# in einem zweiten Terminal – alle Videos oder einzelne (bd, principal, anker-salesops)
PIPER_VOICE=/pfad/de_DE-thorsten-high.onnx DATABASE_URL=postgresql://postgres@localhost:5432/verve_video \
  node docs/video/record.mjs [bd principal anker-salesops]
```

Die Datenbank `verve_video` wird vor jedem Video zurückgesetzt und neu befüllt. Ergebnis: `docs/video/out/*.mp4` (nicht im Repository).
