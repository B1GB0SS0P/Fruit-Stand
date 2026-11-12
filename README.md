# Fruit Stand

A live pricing game for a room of people on their phones, with a projector showing the shared market. Adapted from a game on the Korean show _The Genius_ (Season 3). One game takes 20–30 minutes.

Players are paired up and each sells one fruit. Every round they secretly pick a price from $1 to $5. The lowest price sells all of that fruit, so rivals can cooperate at $5 or undercut each other.

It is one Node.js service (Express + Socket.IO) with no database.

## Run it locally

You need Node.js 20 or newer.

```
npm install
npm start
```

Then open:

| Page | Address |
| --- | --- |
| Host panel | http://localhost:3000/host |
| Players | http://localhost:3000/ |
| Projector | http://localhost:3000/screen?room=CODE |
| How to Play | http://localhost:3000/how-to-play |

Without a `HOST_PASSWORD` set, the local host password is `fruit`. To use your own:

```
# PowerShell
$env:HOST_PASSWORD = "something-secret"; npm start

# macOS / Linux
HOST_PASSWORD=something-secret npm start
```

To try it alone, open the player page in several private windows. Each one becomes a separate player. You need an even number, 4 or more.

## Run the tests

```
npm test
```

This runs the engine tests and the Socket.IO tests, which connect real clients and play full games with 8, 40 and 60 bots. It takes about 40 seconds.

## Deploy to Render

1. Push this repository to GitHub.
2. In the Render dashboard choose **New → Blueprint** and pick the repository. Render reads `render.yaml`.
3. When asked, enter a value for `HOST_PASSWORD`. This is what you type on the host page.
4. Press **Apply** and wait for the first deploy to finish.
5. Open `https://YOUR-SERVICE.onrender.com/host` and log in.

If you would rather set it up by hand, choose **New → Web Service** and use:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check path | `/healthz` |
| Env var `HOST_PASSWORD` | your host password |
| Env var `NODE_ENV` | `production` |
| Env var `NODE_VERSION` | `22` |
| Instances | 1 (the game lives in memory, so it must not be scaled out) |

Things to know about Render's free plan:

- **It sleeps after 15 minutes without traffic**, and the next visit takes about a minute to wake it. Open the host page a few minutes before your session. Once anyone has a page open, the live connection keeps it awake.
- **It can restart at any time, and a restart wipes the game.** See "Recover after a restart" below.

## Host a game

Before people arrive:

1. Open `/host`, log in and press **Create a room**. You get a 4-letter code.
2. Press **Open big screen** and put that tab on the projector. It shows the code, a QR code and everyone who joins.
3. Use **How to play** on the projector to explain the rules. Arrow keys or a click move through the slides.

In the lobby:

4. Players scan the QR code (or go to the site and type the code), then enter a name and pick an avatar.
5. The count must be even and at least 4. If it is odd, **Remove** someone and give them a separate task. **Lock lobby** stops new joins.
6. Press **Start game**.

Each round (there are 4):

7. Players pick a price and press **Submit**, which locks it in. They can use their one Change token before submitting.
8. The round ends when everyone has submitted or the 5-minute timer runs out. At time-out, a price that was picked but not submitted is used, and anyone who picked nothing gets $5.
9. You can use **+1 min**, **Pause**, **Remind** (nudges everyone who has not submitted) and **Set bid** (for someone who cannot use their phone).
10. The projector shows each fruit's lowest price. Press **Start round N** to carry on. New partners are made at round 3.

Round 2 is the Secret Market. Some fruits are announced as secret when the round opens, and their prices stay hidden until the end.

After round 4:

11. Press **Reveal secret prices**. The projector uncovers the secret stands one at a time.
12. When the last one is uncovered, press **Show final standings**.
13. **Download results CSV** gives you every bid, every earning, which fruits were secret and the final totals.

The host panel never shows a price, an earning or a total before the final standings, so you can join as a player on another device.

If a player loses their seat (they closed a private tab, or switched browser), press the 🔑 next to their name for a rejoin code. On their phone they enter the room code, then that rejoin code. A normal refresh or a locked phone reconnects by itself.

## Recover after a restart

The server keeps the game in memory, so a restart loses it. Two things protect you:

- **Autosave.** The host page saves the game in your browser after every change. You do not have to do anything.
- **Manual snapshot.** **Snapshot → Download** on the host panel saves the same thing as a file.

If the server restarts mid-game:

1. Players' phones show "Game paused" and keep trying to reconnect. Tell them to keep the page open.
2. Reload `/host` and log in. This also wakes the server, which can take about a minute.
3. Press **Restore room CODE** on the yellow autosave banner, or **Upload a snapshot** and choose a downloaded file.
4. Phones and the projector reconnect by themselves. The round timer comes back paused with the time it had left.
5. When everyone is back, press **Resume**.

Snapshots are encrypted with the host password, because they contain every bid. A snapshot only opens on a server with the same `HOST_PASSWORD`. The autosave lives in the browser you host from, so restore from that same browser.

## Change the settings

- `config.js` has the fruit list, the avatars and every rule setting: sellers per fruit, price range, number of rounds, the Secret Market round and share, Change tokens, the bid timer, and the player limit (0 means no limit).
- `content/howToPlay.json` has the How to Play slide text and the Secret Market intro. Edit the wording there; no code changes are needed.

With more than 40 players the 20 fruits get three or more sellers each, so the "one rival" line on slide 2 is no longer exact.

## How the code is laid out

| Folder | What it holds |
| --- | --- |
| `game/` | The rules as plain functions: dealing, bidding, scoring, the views each person may see, the CSV and snapshots. No network code. |
| `server/` | Express, Socket.IO, rooms, the round timer and snapshot encryption. |
| `public/` | The four pages: player, projector, host and How to Play. |
| `content/` | The slide text. |
| `test/` | Engine tests and Socket.IO tests. |
