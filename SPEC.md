Build a real-time multiplayer web game called **Fruit Stand**, deployed as a single Render web service. It's adapted from a game on the Korean show _The Genius_ (Season 3). I host it live for up to 40 players on their phones, with a projector showing a shared screen. One game takes 20–30 minutes.

Read this whole spec before writing code. Then reply with your file structure, your visual design plan and any gaps you see in the spec, and wait for my go-ahead before building.

---

## 1. Game rules (the server must enforce all of these)

**Setup**

- **Fruit pool** (in config, each with its emoji): Apple 🍎, Grape 🍇, Melon 🍈, Tangerine 🍊, Strawberry 🍓, Watermelon 🍉, Banana 🍌, Pineapple 🍍, Mango 🥭, Peach 🍑, Pear 🍐, Cherry 🍒, Lemon 🍋, Kiwi 🥝, Coconut 🥥, Blueberry 🫐, Green Apple 🍏, Tomato 🍅, Olive 🫒, Avocado 🥑.
- The number of fruits **in play scales with the player count** (see Dealing). The rest of the pool sits unused.
- 4 rounds:
  - Rounds 1–2 are **Phase 1**.
  - Round 2 is also the **Secret Market round** (see below).
  - Rounds 3–4 are **Phase 2**.
- **The player count must be even, with a minimum of 4.** Teams are always exactly 2 players.
  - The host removes players in the lobby until the count is even. Any extra player gets a separate task offline, or becomes a **predictor** (see Predictors).
  - Starting with an odd count is refused.
  - Predictors are not players. They never count towards the player count, the even-count rule or the teams.
- **Phase 1 teams:** random pairs, made when the host starts the game.
- **Phase 2 teams:** new random pairs, made when round 3 starts.
  - The only constraint is **no one is paired with their Phase 1 partner**. This is a hard rule, except with 4 players, where it may be impossible; then pick the arrangement with the fewest repeats.
  - Two teammates selling the same fruit is allowed. Do not try to avoid it.

**Dealing fruits**

- Each player is dealt **one fruit** when the game starts and keeps it for all 4 rounds. Only a Change (below) alters it.
- **The market scales with the player count.** Sellers per fruit: `sellersPerFruit = max(minSellersPerFruit, ceil(players / sellersDivisor))`. Both settings are in config (defaults 2 and 10).
- Active fruit count: `k = min(poolSize, floor(players / sellersPerFruit))`.

  | Players | Sellers per fruit | Fruits in play |
  | ------- | ----------------- | -------------- |
  | 4–20    | 2                 | players ÷ 2    |
  | 22–30   | 3                 | 7–10           |
  | 32–40   | 4                 | 8–10           |

  For example, 8 players → 4 fruits of 2 sellers, 30 players → 10 fruits of 3, and 40 players → 10 fruits of 4.
- Pick the k active fruits at random from the pool.
- Spread players across the k fruits as evenly as possible. Leftover players add one extra seller to some fruits, so every fruit has `sellersPerFruit` sellers or one more.
- Dealing rules:
  - **Every active fruit has ≥ 2 sellers.**
  - **Phase 1 teammates never share a fruit.**
- Retry random deals until valid (up to ~500 attempts). If none works, show the host an error.

**Bidding (each round)**

- Each player privately submits one whole-number price from **$1 to $5** (min and max in config).
- A player can rebid any number of times until the round resolves. Only the latest bid counts.
- **Each round has a 5-minute bidding timer** (`bidSeconds` in config, default 300). The timer is server-side and starts when the round opens.
  - Every phone and the projector show the same countdown, synced to the server's clock, not the phone's.
  - When the timer hits 0, every player without a bid **automatically gets the max price ($5)**, and the round resolves.
  - Each auto-bid is marked in the CSV.
  - The round **resolves early the instant every player has a bid**.
  - The host can **add 1 minute** or **pause/resume** the timer.
  - The timer must survive a snapshot export/import, restoring the remaining time.
- Teammates discuss strategy in person, so there's no in-app chat.

**Scoring a fruit in a round**

- `units` = number of players selling that fruit this round.
- `lowest` = lowest bid among those sellers.
- Each seller who bid `lowest` earns `lowest × units ÷ (number of sellers tied at lowest)`. Every other seller of that fruit earns 0.
- This works for any number of sellers. Example: Apple has 3 sellers bidding $5, $5 and $4. The $4 seller earns 3 × $4 = $12 and the others earn $0. If all three bid $5, each earns $5. If two tie at $4, each of those two earns $6.

**Change (ability token)**

- Each player has **1 Change token for the whole game**. An unused token carries into Phase 2.
- Using it switches the player's fruit to another fruit. Config `changeTargets` sets which fruits are allowed:
  - `"active"` (default): only fruits in play this game.
  - `"any"`: any fruit in the pool.
- A Change is only allowed during bidding, and **only before that player has bid this round**.
- It's permanent, and it's announced to everyone immediately (e.g. "Ben changed Grape → Melon").
- Round 2 is no different: a player may Change into any allowed fruit. A secret fruit is not special for Change, since nobody knows which fruits are secret.
- If a Change is invalid (no token, already bid, or invalid fruit), reject it, keep the token, and tell the player why.

**Secret Market (round 2 only)**

- When round 2 opens, the server randomly picks `max(1, round(k × secretShare))` active fruits as **secret fruits**. `secretShare` is in config, default 0.25 (so 40 players → 3 of 10 fruits; halves round up).
- **Nobody is told which fruits are secret, or how many.**
  - Round 2 opens with a neutral teaser only: "Some stands might close up shop… 👀".
  - No UI says that a specific fruit is secret.
  - **Every stand shows a curtain** during round 2 bidding, on the projector and on phones.
- **When round 2 resolves,** the curtains lift only on the non-secret fruits, which then show their lowest price. Secret fruits stay curtained until the final reveal.
- **The secret fruit list never leaves the server before round 2 resolves.** No secret flag, no list, and no field anywhere that labels a fruit as secret, in any payload to players, host or screen. The only exception is the ambient sequence below, which carries only emojis and timing.
- Scoring for secret fruits works exactly as normal. Only the reveal changes:
  - **Nobody** learns a secret fruit's lowest price before the end, including its own sellers. A seller who bid $5 on a secret fruit doesn't know whether they earned $5 or $0.
- The teaser and the curtains appear in the UI **only during round 2** (its opening, its bidding and its results). Nothing is mentioned in the lobby, round 1, or rounds 3–4.
- **At the final standings, reveal round 2's secret prices** in a dramatic step: each secret stand uncovers one by one on the projector before the leaderboard appears.
- Rounds 1, 3 and 4 have no secret fruits.

**Round 2 ambience (a hidden tell)**

- During round 2 bidding only, fruit emojis drift slowly in the background, like faint decorative leaves: noticeable if you look, never distracting.
- **They are a deliberate clue: secret fruits appear more often.**
  - Each spawned fruit is chosen by weighted random. Secret fruits get weight `ambientSecretWeight` (config, default 3); active non-secret fruits get weight 1.
  - Fruits that aren't in play are never used.
  - Tuned so a player watching for about 60 seconds can spot the pattern, but a casual glance can't.
- **Privacy:** the server pre-generates the spawn sequence when round 2 opens and sends only that: a list of `{ emoji, delay, duration }`. Nothing else in it.
- **Where:** projector and phones. Both play the same sequence in order, so the weighting is the same on both.
- **Never mention this tell** anywhere in the UI or in How to Play.
- Look and motion are in Visual design.

**What gets revealed**

- After each round, everyone sees **each sold fruit's lowest price**, except secret fruits in round 2, which stay curtained.
  - List every fruit that had at least one seller that round.
  - Never show names, who won, earnings, or running totals.
- Players never see their own earnings during the game.
- After round 4:
  1. Reveal the secret prices (above).
  2. Reveal the predictions: **"🔮 Predictors vs Host"** (see Predictors).
  3. Show the **final standings**. Each player's total is `(Phase 1 team's combined earnings ÷ 2) + (Phase 2 team's combined earnings ÷ 2)`. List every player, ranked, with their avatar and total to 2 decimal places. Tied totals share a rank.
  4. Each player also gets **their own receipt** on their phone: their earnings per round, each team's total ÷ 2, their final total and their rank. A player never receives anyone else's receipt.

**Predictors**

A side game. Predictors watch the market and guess how it will end. The host always predicts too.

_Who predicts_

- In the lobby, the host's player list has a **Make Predictor** button next to Remove, with a confirm step.
  - A predictor is not a player: no fruit, no bid buttons, no Change token, no team. They don't count towards the even-count rule.
  - A room has 0–3 predictors (`maxPredictors` in config).
  - While still in the lobby, the host can turn a predictor back into a player, or remove them.
  - A predictor keeps their name, avatar, colour ring and seat (token and rejoin code).
- The host always predicts too, from the host screen.
- The host and player identities are separate, so the server cannot know that the host is also playing. The host's prediction form has an **"I'm also playing"** tick box. It ticks itself when the host's browser also holds a player seat in the room. While it is ticked, the form shows: "You're also playing. Your predictions may influence your play."

_What predictors see_ (the same public info as players, minus their own stand)

- The teams, Change announcements, each round's results, the timer and "X / N bids in".
- No bids, no earnings and no totals before the end. The secret list stays hidden, exactly as for players.
- A small banner: "You can walk around, chat and influence the market, but you can't bid."

_The three predictions_

1. **Median total:** the average of the totals at the two middle positions. With N players, sort by total; the middle positions are N/2 and N/2+1. Entered in dollars, to 2 decimal places.
2. **Winner:** pick one player.
3. **Middle player:** pick one player who will finish at position N/2 or N/2+1.

- The pickers show each player's avatar, colour ring and name, with a search box (there are up to 40 players).
- Predictions open when the game starts (the players are fixed from then on). Each answer saves as soon as it is entered.
- **Lock time:** config `predictionLockRound`, default 3.
  - Predictions can be edited until the host presses Next round to start that round. They then lock automatically.
  - Any answer still missing at the lock scores 0.
  - The host's form shows who has and hasn't submitted all three (names only). It never shows anyone's answers.
- **Hidden until the end:** nobody sees another person's prediction, the host included, until the reveal.

_Scoring_ (each question is worth up to 5 points, 15 in total)

- **Median total:** `max(0, 5 − round(|guess − actual|))`. Both amounts are taken to the cent, as shown on screen, and a half rounds up. For example, if the actual median is $14.50, a guess of $13.00 is $1.50 off, which rounds to 2, so it scores 3 points.
- **Winner:** uses the picked player's final rank. Tied players share a rank.
  - Rank 1 scores 5, rank 2 scores 4, rank 3 scores 3, rank 4 scores 2, rank 5 scores 1, and anything lower scores 0.
  - Players tied for 1st all count as rank 1.
- **Middle player:**
  - Tied players share a rank and together fill the positions from that rank downwards (3 players tied at rank 19 fill positions 19, 20 and 21).
  - `d` is 0 if the pick, or anyone tied with the pick, is at position N/2 or N/2+1. Otherwise `d` is the distance from the pick's tied group to the nearer middle position. With no ties this is simply the distance from the pick's rank to the nearer of N/2 and N/2+1.
  - Score `max(0, 5 − d)`.
- **Who wins:** the highest total. Ties are broken by whoever was closer on the median (no median guess counts as furthest). If they're still tied, it's a draw.

_End-of-game reveal_

- It runs on the projector after the secret stands uncover and **before** the podium, under the title "🔮 Predictors vs Host". One question at a time:
  1. the actual answer;
  2. each predictor's and the host's answer beside it;
  3. the points awarded, with a short count-up animation.
- It finishes with a predictor scoreboard, and confetti for the predictor winner.
- On a predictor's own phone, once the final standings show: their answers, the actual results and their points per question, styled as a receipt like the player receipt.

_Data and privacy_

- Predictions are stored on the server only. They are sent to the person who made them (for editing before the lock), and to everyone only at the reveal.
- The CSV export includes each predictor's and the host's answers, the actual values and the points per question.
- Snapshots include predictors, predictions and the lock state.

---

## 2. Screens and flow

Mobile-first: players are on phones, and the projector shows the shared screen.

**Join flow (Kahoot-style, at `/`)**

1. **Room code:** one big input and a big button. A wrong code gives a friendly error. A locked room says it's locked.
2. **Name:** 1–20 characters, unique per room ignoring case. A taken name asks for another.
3. **Avatar:** pick from a grid of ~24 simple **animal emoji icons** (🐶🐱🐼🦊🐸🐧🐨🐯 …).
   - **No fruit icons**, so an avatar can't be confused with the fruit a player sells.
   - Each player gets their animal **plus a colour ring**. The animal + colour combination is unique within the room, so no two players look identical.
   - Players pick the animal, and several players may pick the same one. The server assigns the first free colour for that animal from the ring colour list in config. If every listed colour is taken for that animal, the server makes up a further distinct colour, so a join is never refused over this.
   - The ring is shown everywhere the avatar appears: projector lobby, team display, standings, receipt and the host's player list.
4. **Waiting screen:** "You're in!", with their avatar and name, and a live count of joined players.

The projector lobby shows each avatar and name popping in as players join, Kahoot-style.

**Player screen (phone)**

- If the host removes them: "You've been assigned a separate task — please see the host." Their token is revoked, and they can rejoin only if the host unlocks the lobby.
- **During the game,** the player sees **their own little fruit stand**: an awning, their fruit displayed on the counter, and a price tag. It shows:
  - the round number and phase, and the countdown timer, which pulses in the last 30 seconds with the hint "No bid = $5";
  - their team, with their teammate's avatar, name and fruit;
  - how many other players sell their fruit (a count only, never names);
  - the **$1–$5 price buttons, styled as price-tag stickers**, with the current bid stuck on the stand;
  - the Change token and its button, with a confirm step that shows a fruit picker. The picker looks the same in every round;
  - in round 2, the teaser banner "Some stands might close up shop… 👀", and a curtain on their stand (every player's stand is curtained, so it tells them nothing);
  - a scrollable history of past rounds' results;
  - public Change announcements as they happen.
- **Predictor's phone** (instead of a stand):
  - the round, phase, countdown timer and "X / N bids in";
  - the banner "You can walk around, chat and influence the market, but you can't bid.";
  - the prediction form (median total, winner picker, middle player picker). After the lock it becomes a read-only "🔒 Predictions locked" card showing their own answers;
  - the teams, Change announcements and each round's results, exactly as public as for players (curtains and teaser included in round 2);
  - at the end: their prediction receipt, then the standings list.
- **Final screen:**
  - **A receipt from the player's stand:** a paper-receipt look with a torn edge and a monospace price column. It lists each round's earnings (R1, R2, R3, R4), Team 1 total ÷ 2, Team 2 total ÷ 2, the final total and the rank ("#3 of 40").
  - **Then a compact standings list,** with the player's own row highlighted and the list auto-scrolled to it.
- Every action gets **instant visible feedback**, such as a sticker slapping on or a toast. Nothing may fail silently.

**Projector screen (`/screen?room=CODE`, read-only)**

- **Lobby:** the room code in big text, the join URL with a QR code, avatars popping in, and the player count.
- **Round:**
  - the whole market as a row or grid of little stands, one per active fruit;
  - "X / N bids in" (no names) and a big countdown timer;
  - a small note under the round title saying whether predictions are still open or locked;
  - a toast for each Change announcement.
  - With 20 fruits, the stands must still fit on one 16:9 screen without scrolling.
- **Round 2 start:** the teaser card "Some stands might close up shop… 👀" shows briefly, then a curtain drops over **every** stand. The ambience fades in.
- **Results:** price tags drop onto each stand. After round 2, the curtains lift on the non-secret stands only; the rest stay curtained with no price. The ambience fades out.
- **End (final standings),** on the dusk background:
  1. The secret stands uncover one by one, showing their round 2 lowest prices.
  2. **"🔮 Predictors vs Host":** the three questions one at a time (actual answer, everyone's answer, points counting up), then the predictor scoreboard with confetti for the predictor winner. Players' phones say to watch the big screen.
  3. 3rd place is revealed, then 2nd, then 1st, with a pause between each.
  4. Confetti for 1st place.
  - **Podium:** the steps look like market stalls (striped awning, crates, chalkboard sign) with clearly different heights. Ties are labelled "T-2" and so on and share a step. A step is chosen by the rank number, so numbering never skips onto the wrong step: two players tied for 1st share the top stall, the next player is 3rd and stands on the 3rd stall, and the 2nd stall is left out.
  - **Below the podium:** a full ranked board in 2–3 columns that fits 40 players on one 16:9 screen without scrolling. Each row shows rank, avatar with its colour ring, name and total.

**Host screen (`/host`, password from an env var)**

- Create a room, which generates a short code (e.g. 4 letters).
- **Lobby:**
  - a live player list with a **Remove** button and a **Make Predictor** button on each (both with confirm);
  - a list of the predictors (up to `maxPredictors`), each with **Make player** and **Remove**;
  - a **Lock lobby** toggle;
  - the player count, shown prominently;
  - a **Start** button that stays disabled while the count is odd or under 4, with a hint like "11 players: remove 1 to start".
- **Predictions:** from the start of the game the host has their own prediction form (the same three questions), the "I'm also playing" tick box, and a list of who has and hasn't submitted all three (names only). It locks with everyone else's.
- **Start game**, then **Next round** (only after the current round resolves). After the last round: **Reveal hidden prices**, then **Predictors vs Host**, then **Show final standings**. **Reset**, either keeping players or wiping them, with a confirm step.
- **Status:** who has bid and who hasn't, as names only. **Never show the host any prices, earnings, totals, secret prices or which fruits are secret before the end.** I may be playing myself.
- **Remind:** sends a nudge to everyone who hasn't bid.
- **Timer controls:** +1 min and pause/resume.
- **Set bid for a player:** for someone whose phone died. The host enters it blind.
- **Download the final results CSV** after the game ends. It includes all bids per round with earnings, which fruits were secret, the final totals, and the predictions (everyone's answers, the actual values and the points per question).
- **Download or upload a game snapshot (JSON)** at any time, to restore the game after a server restart.
- The host can also join as a player from another device. Host and player identities are separate.

**How to Play (`/how-to-play`, plus a button on the projector lobby and on the phone waiting screen)**

- A step-through slideshow in the same stand theme. On the projector, it's controlled with arrow keys or a click; on phones, by swiping.
- I'll use it to explain the game before starting.
- Each slide has one idea, a big illustration (stands, price tags, avatars) and at most ~25 words. Use this content:
  1. **Welcome to Fruit Stand 🍎** — You and a partner run fruit stands. Most money at the end wins.
  2. **Your fruit** — You get one fruit and keep it all game. A few other players sell the same fruit. They're your competition. Your partner sells a different fruit.
  3. **Set your price** — Each round, secretly pick $1–$5 on your phone. You have 5 minutes. No bid = $5.
  4. **Cheapest wins** — The cheapest stall gets all the customers for that fruit. Ties split. Illustration: 3 sellers at $5, $5 and $4 → the $4 seller earns 3 × $4 = $12, the others earn $0. All three at $5 → $5 each.
  5. **Work it out together** — Chat with your partner and the other sellers of your fruit. Figure out your prices together. Only each fruit's lowest price is shown.
  6. **Change token 🔄** — Once per game, switch to another fruit before you bid. Everyone is told.
  7. **Partners** — Rounds 1–2 with one partner, rounds 3–4 with a new one. Your score = half of each team's earnings.
  8. **Winning 🏆** — Nobody sees totals until the end. Final standings are revealed after round 4.

- Keep the wording neutral and business-like ("the cheapest stall gets the customers"). Nothing about rivals or betrayal.
- **Don't mention the Secret Market or the round 2 ambience anywhere in How to Play.** It's a surprise. When round 2 starts, show only the teaser: "Some stands might close up shop… 👀". Round 2's results add one line: "Some stands stayed closed. Their prices stay hidden until the end — even from their sellers."
- Keep the slide text, the teaser and the results line in one config or content file so I can edit the wording without touching code.

---

## 3. Visual design

- **Theme:** a cute market of fruit stands, with striped awnings, wooden counters, chalkboard or price-tag stickers, and warm, friendly colours.
  - Everything should be original art made with CSS, inline SVG and emoji. Use no external images, no assets from Kahoot, Fruit Ninja or any other game, and no logos or characters from them.
- **Background: a market from morning to dusk.** A layered scene whose sky follows the game state:

  | State           | Sky                                    | Extra                                              |
  | --------------- | -------------------------------------- | -------------------------------------------------- |
  | Lobby           | Early morning: pale peach → light blue | Chalkboard sign "OPENING SOON"                     |
  | Round 1         | Bright morning: soft blue              | Sun low on the left                                |
  | Round 2         | Midday, slightly hazy and warm         | Sun near the top; the round 2 ambience lives here  |
  | Round 3         | Afternoon: golden                      | Longer, warmer light                               |
  | Round 4         | Sunset: orange → pink                  | String lights start to glow                        |
  | Final standings | Dusk: deep purple → navy               | String lights fully lit, confetti on reveal        |

  The secret reveal step uses the dusk scene too. Layers, back to front:
  1. **Sky gradient.** Cross-fades between states over about 3 seconds.
  2. **Distant skyline** (projector only). Soft, flat silhouettes of shophouse rooftops and a few rain trees and palms, for a Singapore pasar / night-market feel. Inline SVG, about 15% darker than the sky, low contrast. Its tint follows the sky.
  3. **Bunting.** Triangle flags strung across the top in the stand colours, with a slow, gentle sway.
  4. **Content:** the stands, cards and so on.
  5. **Ground strip.** Wooden planks along the bottom 10–15% of the projector. The stands sit on it rather than floating.
  6. **Paper grain.** A very faint noise texture over the whole screen (an SVG `feTurbulence` data-URI). It must not reduce legibility.
  - **Projector:** detail goes only at the top (sky, bunting) and bottom (ground). The middle band, behind stands, text and numbers, stays calm and low contrast.
  - **Phone:** the same sky colours per state, bunting along the top edge, a plank strip at the bottom, and **no skyline**. Content cards stay solid cream with a soft shadow, so text is always readable.
  - Text that sits directly on the sky switches between dark and light ink to suit the sky colour.
- **Round 2 ambience** (see Secret Market for what it means):
  - opacity 0.12–0.2, softened with `saturate(0.6)` and a slight blur;
  - sizes 24–64px on the projector, 18–36px on phones;
  - slow drift, 20–40 seconds per pass, with gentle sway and rotation, random start positions and delays, entering and leaving off-screen;
  - 8–12 on screen at once on the projector, 4–6 on phones (`ambientCountProjector`, `ambientCountPhone`);
  - above the background layers but below all content, `pointer-events: none`, never covering text or buttons;
  - fades in when round 2 opens, fades out when round 2's results appear.
- **Animation:**
  - Use CSS transforms and opacity only. No canvas and no JS animation loops.
  - Phones get light animation only (a sticker pop, a banner slide, the sparse ambience).
  - Respect `prefers-reduced-motion`: animations become fades, there is no sway or drift, and sky changes are instant swaps.
  - Pause all animation while the tab is hidden.
- **Performance:** it must run smoothly on cheap Android phones with 40 players connected. No canvas loops running constantly on phones.
- **Readability:** large text and tap targets of at least 44px. The projector must be readable from the back of a lecture room.

---

## 4. Technical requirements

**Stack:** Node.js (LTS), Express and Socket.IO. Serve the frontend from the same service, either as plain HTML/JS or a small Vite build. It must be **one deployable service with no database**.

**Server-authoritative**

- All rules, validation and scoring run on the server. The client only sends intents (`join`, `bid`, `change`) and renders what it receives.
- Each recipient gets **their own view**:
  - a player receives only their own bid, their team's info, public announcements and results;
  - which fruits are secret is never sent to any client before round 2 resolves (the ambient sequence of emojis and timing is the one deliberate exception);
  - secret fruits' prices are never sent to any client until the end reveal;
  - other players' bids never reach any client before the end, including the host and the screen;
  - a prediction is sent only to the person who made it until the prediction reveal. The host gets names of who has submitted, never answers.

**Game logic as a pure module** (e.g. `game/engine.js`)

- Plain functions over a state object, with no Socket.IO or Express inside.
- Use a seedable random number generator so tests are deterministic.
- Socket handlers stay thin: they validate input, call the engine, then emit each recipient's view.

**Identity and reconnects**

- On join, give each player a random token and store it in `localStorage`, wrapped in try/catch, falling back to the URL.
- A returning token restores the player's seat.
- Phones lock and switch apps, so use Socket.IO auto-reconnect and send a full state resync on every reconnect.

**Concurrency**

- Every mutation must be idempotent and validated against the current round number.
- Reject stale buttons from earlier rounds, never double-apply a bid, and resolve each round exactly once.

**Rooms:** multiple concurrent rooms, keyed by code. Delete a room after 3 hours of inactivity.

**Render constraints** (from Render's docs, so design around them):

- Free web services **spin down after 15 minutes without traffic**, and the next request then takes about **1 minute to start up**. Messages on open WebSockets count as traffic.
- The **filesystem is ephemeral**, and Render **may restart a free service at any time**. All in-memory state is lost on restart, which is why the snapshot download and upload exist.
- Read `PORT` from env, add `GET /healthz`, and provide a `render.yaml` or the exact dashboard settings (build command, start command, and the env vars `HOST_PASSWORD` and `NODE_ENV`).

**Config** (one file, with defaults):

| Setting                  | Default                          |
| ------------------------ | -------------------------------- |
| Fruit pool               | the 20 fruits above, with emojis |
| Avatar set               | ~24 animal emojis                |
| `minSellersPerFruit`     | 2                                |
| `sellersDivisor`         | 10                               |
| `maxPredictors`          | 3                                |
| `predictionLockRound`    | 3                                |
| `changeTargets`          | `"active"`                       |
| Min / max price          | 1 / 5                            |
| Total rounds             | 4                                |
| Last round of Phase 1    | 2                                |
| Secret round             | 2                                |
| `secretShare`            | 0.25                             |
| Change tokens per player | 1                                |
| `bidSeconds`             | 300                              |
| Max players per room     | 40                               |
| `ambientSecretWeight`    | 3                                |
| `ambientCountProjector`  | 10                               |
| `ambientCountPhone`      | 5                                |
| `skyTheme`               | per-state colour stops (lobby, round1–round4, final), so the palette can be tweaked |
| `avatarRingColors`       | the avatar ring colour list      |

---

## 5. Tests (required before you call it done)

Use Vitest (or similar) for the engine, plus Socket.IO integration tests with real client connections. Cover at least:

1. **Join:**
   - invalid room codes, name length and duplicate names (any case) are rejected;
   - a locked lobby refuses joins;
   - an avatar is required;
   - 40 players picking the same animal all get distinct animal + colour combinations;
   - a removed player's token is revoked;
   - starting is refused with an odd count or fewer than 4 players.
2. **Dealing,** for every even player count from 4 to 40:
   - `sellersPerFruit` and the active fruit count match the formulas;
   - every active fruit has at least `sellersPerFruit` sellers and at most one more;
   - Phase 1 teammates never share a fruit;
   - each player has exactly one fruit;
   - fruits persist across rounds.
3. **Phase 2 teams:**
   - no repeat partners for 6+ players;
   - every player is in exactly one pair.
4. **Bids:**
   - out-of-range and non-integer bids are rejected;
   - a rebid overwrites the old bid;
   - a stale round number is rejected;
   - the round resolves exactly once, on the last bid;
   - **timer:** on expiry, missing bids become $5 and the round resolves; an early full set of bids cancels the timer; +1 min and pause/resume work; a bid arriving after expiry is rejected. Use fake timers.
5. **Scoring:** a single lowest bidder, a two-way tie, and a fruit with 1 or 3 sellers after a Change. Markets of 3, 4 and 5 sellers, including a single lowest seller, a 2-way tie and an everyone-ties case for 4 sellers.
6. **Change:**
   - refused after bidding, with the token kept;
   - permanent;
   - announced to everyone;
   - a second use is refused;
   - works in Phase 2 with a carried-over token;
   - the `changeTargets` modes behave as specified;
   - **Changing into a secret fruit in round 2 is allowed, and the Change targets carry no secret marking.**
7. **Secret Market:**
   - happens only in round 2;
   - the count matches the formula;
   - **the secret list appears in no payload to any client (players, host, screen) before round 2 resolves**: no flag, list or field that labels a fruit as secret;
   - every stand is curtained during round 2 bidding; after it resolves only the secret fruits stay hidden;
   - their prices appear in no payload to any client (players, host, screen) until the end reveal;
   - **ambience:** the sequence contains only emojis and timing; it uses only fruits in play; over many samples the frequencies match the weights; it is sent only during round 2 bidding;
   - scoring for secret fruits is unchanged;
   - the end reveal shows the correct prices;
   - the CSV marks secret fruits.
8. **Privacy:** results payloads never contain names or earnings, and the host's status view never contains prices.
9. **Totals:** final totals match the formula, and **the sum of all players' totals equals the sum of all earnings**. Each player's receipt adds up to their total and is sent only to them, only at the final standings.
10. **Snapshots:** export mid-round 2 (with secret fruits set and the timer running), import, and the game continues identically, with the same remaining time.
11. **Full simulated games** through Socket.IO, from join to final standings, with 8 bots and with 40 bots.
12. **Predictors:**
    - making and unmaking a predictor in the lobby; predictors don't count towards the even-count check; at most `maxPredictors`;
    - a predictor can't bid, Change or receive a fruit;
    - predictions are editable before the lock and rejected after it; missing answers score 0;
    - no payload contains another person's predictions before the reveal, and that includes the host;
    - scoring: the median uses the two middle totals; the winner pick with a tie for 1st; the middle pick, exact (either middle rank) and off by 1, 2 and 6 positions; the tie-break by median closeness;
    - a full simulated 40-player game with 2 predictors plus the host, ending in a correct reveal payload;
    - a snapshot round-trip taken mid-game after the predictions lock.

---

## 6. Deliverables

- Complete, runnable files, with no placeholders or TODOs.
- A `README.md` covering:
  - running locally;
  - running the tests;
  - deploying to Render step by step;
  - hosting a game;
  - recovering after a restart from a snapshot.
- Tell me about any rule here you think is ambiguous or broken **before** you implement around it.
