# Collab
globe go spin 🌍

## Running
- **start.bat** – starts a local server (no installs needed) and opens the browser. Close the window to stop it.
- **VS Code Live Server** – right-click `index.html` → "Open with Live Server".

Opening `index.html` directly (file://) won't work, since browsers block loading the data files that way.

## Country info panel
Choose a country (click it in the search results or press Enter) and a card appears top-left with live population, local time, weather, births/deaths today, earthquakes and more. Editing the search text (e.g. Backspace) hides it. Code lives in `panel.js`; it needs an internet connection (REST Countries, World Bank, Open-Meteo, USGS - no API keys).
