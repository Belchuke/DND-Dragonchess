# Dragonchess

**Three realms, one throne.** Dragonchess is a three-level chess variant you can play online against other people.

## Play now, for free

**[dragonchess.belch.dk](https://dragonchess.belch.dk)**

Play in your browser with nothing to install. Make a free account and you can:

- **Find Match**: rated games against opponents close to your Elo
- **Host / Join**: private, unranked games with a friend using a 6-character code
- **Rematch**: play again with colours swapped
- **Profile**: see your rating, record and past games, and look back at finished games with their full move list and final board

## Under development

This project is still being worked on. Expect rough edges, rule tweaks and the odd bug. Games that are still in progress may be lost when the server restarts; finished games and ratings are saved. If you find a bug or a rule that seems wrong, please open an issue.

## The rules

The rules come from **Gary Gygax's _Dragonchess_**, first published in _Dragon_ magazine #100 (August 1985).

The game is played on three stacked 12×8 boards:

| Level | Realm      | Some of the pieces there                                             |
| ----- | ---------- | -------------------------------------------------------------------- |
| 3     | Sky        | Sylph, Griffon, Dragon                                               |
| 2     | Ground     | King, Mage, Paladin, Cleric, Hero, Thief, Unicorn, Oliphant, Warrior |
| 1     | Underworld | Dwarf, Basilisk, Elemental                                           |

Pieces move within their own level, and many can also move between levels. Gold moves first, and you win by checkmating the enemy King. A few special rules:

- **Dragon remote capture**: a Dragon on the Sky level can take an enemy on the Ground level directly below it or next to that square, without moving.
- **Basilisk freeze**: an enemy on the Ground level directly above a Basilisk can't move.
- **Warrior promotion**: a Warrior that reaches the far rank becomes a Hero.
- There is no castling, no two-square pawn move and no en passant.

The original rules leave some cases unclear. Where they do, this implementation follows the usual chess convention: captures are allowed unless the rules forbid them, and multi-square moves can't jump over pieces unless the rules say they can. Stalemate is a draw. The full list of these decisions is under **Interpretation notes** in the in-game rules panel, next to a guide for every piece.

## How it works

- **Frontend**: one `index.html` file (plain HTML, CSS and JavaScript) with no build step.
- **Backend**: Node.js and TypeScript with Socket.IO for real-time play and SQLite (better-sqlite3) for storage.
- **Server-authoritative**: the server checks every move with the same rules engine the client uses, so nobody can cheat by changing the page.
- **Accounts**: passwords are hashed with bcrypt plus a server-side pepper. Sessions use HttpOnly cookies.

```
index.html            the whole frontend
server/
  src/                backend (TypeScript)
  test/               tests (Vitest)
  migrations/         SQL migrations, applied at startup
  deploy/             example systemd unit
  Dockerfile
docker-compose.yml
```

## Running it locally

Requires Node.js 18 or newer.

```sh
cd server
npm install
npm run dev        # http://127.0.0.1:3543
```

Other useful commands:

```sh
npm test           # run the tests
npm run typecheck  # type-check without building
npm run build      # compile to dist/
```

Or with Docker:

```sh
docker compose up --build
curl http://127.0.0.1:3543/health   # {"status":"ok"}
```

## Credits

Dragonchess was designed by Gary Gygax and first published in _Dragon_ magazine #100 (1985). This is an unofficial fan project and is not affiliated with or endorsed by TSR or Wizards of the Coast.
