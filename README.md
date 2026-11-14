# Fruit Stand

A live pricing game for a room of people on their phones, with a projector showing the shared market. Adapted from a game on the Korean show _The Genius_ (Season 3). One game takes 20–30 minutes.

Players are paired up and each sells one fruit. Every round they secretly pick a price from $1 to $5. The lowest price sells all of that fruit, so the sellers of a fruit can all hold at $5 or undercut each other.

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

This runs the engine tests and the Socket.IO tests, which connect real clients and play full games with 8, 40 and 60 bots, and a 40-player game with 2 predictors and the host. It takes about 45 seconds.

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
5. The count must be even and at least 4. If it is odd, **Remove** someone and give them a separate task, or press **Make Predictor** on them. **Lock lobby** stops new joins.
6. Optional: choose up to 3 **predictors** with **Make Predictor**. A predictor does not play: no fruit, no bids, and they do not count towards the even number. They watch the market and predict how it ends. **Make player** undoes it while you are still in the lobby.
7. Press **Start game**.

The market grows with the room: 2 sellers per fruit up to 20 players, 3 up to 30 and 4 up to 40 (so 40 players share 10 fruits).

Predictions (the predictors on their phones, and you on the host panel):

- Three questions: the **median total** (the average of the two middle totals, in dollars and cents), the **winner**, and a **middle player** (someone who finishes in one of the two middle places).
- Each answer saves as soon as it is entered and can be changed until you press **Start round 3**. Then everything locks. A missing answer scores 0.
- Your panel lists who has submitted all three, by name only. Nobody sees anyone else's answers before the reveal, and that includes you.
- If you are also playing, tick **I'm also playing in this game**. It ticks itself if this browser also holds a player seat in the room.

Each round (there are 4):

8. Players pick a price and press **Submit**, which locks it in. They can use their one Change token before submitting.
9. The round ends when everyone has submitted or the 5-minute timer runs out. At time-out, a price that was picked but not submitted is used, and anyone who picked nothing gets $5.
10. You can use **+1 min**, **Pause**, **Remind** (nudges everyone who has not submitted) and **Set bid** (for someone who cannot use their phone).
11. The projector shows each fruit's lowest price. Press **Start round N** to carry on. New partners are made at round 3, and predictions lock.

Round 2 is the Secret Market. Nobody is told which fruits are secret, or how many, and that includes you: the host panel never shows it. The round opens with a teaser ("Some stands might close up shop… 👀") and a curtain on every stand. When the round ends, the curtains lift on the ordinary fruits and their prices show; the secret fruits stay curtained until the end.

During round 2 only, faint fruit drifts across the background of the projector and the phones. It is a deliberate clue: secret fruits drift past about three times as often as the others. Don't mention it. Let the room work it out.

After round 4:

12. Press **Reveal hidden prices**. The projector uncovers the secret stands one at a time.
13. When the last one is uncovered, press **Predictors vs Host**. The projector takes the three questions one at a time (the actual answer, everyone's answer, then the points counting up) and ends on the predictor scoreboard. It takes about 40 seconds. Note that the Winner question shows who came 1st, just before the podium does. **Skip to standings** leaves this step out.
14. Press **Show final standings**. The projector reveals 3rd, then 2nd, then 1st, then the full board. Each phone shows that player's own receipt and the standings; a predictor's phone shows their prediction receipt.
15. **Download results CSV** gives you every bid, every earning, which fruits were secret, the final totals and the predictions with their points.

How predictions are scored (5 points per question, 15 in all):

| Question | Points |
| --- | --- |
| Median total | 5 minus the distance from the actual median, rounded to whole dollars (a half rounds up). $1.50 off scores 3. |
| Winner | 5 if the pick finishes 1st, 4 for 2nd, 3 for 3rd, 2 for 4th, 1 for 5th. Players tied for 1st all count as 1st. |
| Middle player | 5 if the pick finishes in one of the two middle places, 1 fewer for each place further away. Tied players share their places, so a pick tied with someone in the middle scores 5. |

The highest total wins. A tie goes to whoever was closer on the median; if that is level too, it is a draw.

The host panel never shows a price, an earning, a total or which fruits are secret before the final standings, so you can join as a player on another device.

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

- `config.js` has the fruit list, the avatars and every rule setting: the market size (`minSellersPerFruit` and `sellersDivisor`), the predictors (`maxPredictors`, and `predictionLockRound` for when predictions lock), price range, number of rounds, the Secret Market round and share, Change tokens, the bid timer, and the player limit (0 means no limit).
- `config.js` also has the look:
  - `skyTheme`: the sky colours for the lobby, each round and the final standings, top to bottom. Change one state and the rest keep their defaults.
  - `avatarRingColors`: the ring colours. Each player gets the first one that is free for their animal, so no two players look the same.
  - `ambientSecretWeight` (default 3): how much more often a secret fruit drifts past in round 2. Set it to 1 to remove the clue.
  - `ambientCountProjector` (10) and `ambientCountPhone` (5): how many fruits drift on screen at once. 0 turns the drifting fruit off.
- `content/howToPlay.json` has the How to Play slide text, the round 2 teaser and the round 2 results line. Edit the wording there; no code changes are needed.

## Preview the screens

```
npm run preview
```

This plays two real games with bots (4 and 40 players) and saves screenshots of the projector and a phone at the lobby, round 2, round 4 and the final standings into `preview/`. It needs Chrome or Edge installed. `npm run preview -- 12` uses another player count.

`npm run preview -- predictions` plays a 40-player game with 2 predictors and the host, and saves the prediction form, the locked screen and the "Predictors vs Host" reveal (projector, a predictor's phone and the host panel) into `preview/predictions/`.

The market scales with the room: 2 sellers per fruit up to 20 players, 3 up to 30 and 4 up to 40.

## How the code is laid out

| Folder | What it holds |
| --- | --- |
| `game/` | The rules as plain functions: dealing, bidding, scoring, the views each person may see, the CSV and snapshots. No network code. |
| `server/` | Express, Socket.IO, rooms, the round timer and snapshot encryption. |
| `public/` | The four pages: player, projector, host and How to Play. |
| `content/` | The slide text. |
| `test/` | Engine tests and Socket.IO tests. |
