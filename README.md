# Neon Ark

**Neon Ark（星際特工：霓虹方舟）** is a browser-based Three.js sci-fi action game. Play through three missions: explore the Energy Maze, survive the Starbreak, and face the Ark Guardian. The game includes three independent save slots and upgrades for the plasma cannon, ion thrusters, and deflector shield.

## Run locally

Requirements: Node.js and pnpm 10.18.0 (the version recorded in `package.json`).

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Vite serves the game locally, normally at `http://localhost:5173`. To create a production build or run the checks:

```bash
pnpm build
pnpm test
pnpm smoke  # after building; requires the Playwright browser runtime
```

The repository includes the character model and the game’s favicon/share artwork so the project assets are available in a fresh clone.

## Controls

Use the controls shown in the game’s interface. Keyboard, mouse, gamepad, and touch input are supported by the game.

## Credits and licensing

The bundled ManusCC0 fonts include their CC0 1.0 license in `public/fonts/ManusCC0-LICENSE.txt`. Third-party dependencies retain their respective licenses. No overall license is specified for the game repository.
