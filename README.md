# MeowStreets Extra Info

A userscript that adds extra information to [MeowStreets](https://meowstreets.com). It reads what the page already shows (and the JSON the game's own pages fetch from their own API) and draws numbers next to it. It never plays for you.

> **Unofficial.** Not made by or affiliated with MeowStreets. Their terms ban "bots, scripts or automation that play for you". This script is display-only: it clicks nothing and presses nothing, and it only asks the game for anything if you give it a key for the game's official read-only API (see below). Read the game's own rules and decide for yourself.

## What it shows

- **Crimes pages:** on the street, a table of the best place in each job (the game's odds there, $ and XP per nerve, mastery and successes to the next level). On each job's page: $ and XP per nerve, the game's success % with where every point comes from (the game's own list of your bonuses), heat and when it is back to 0, what the mastery unlocks do, tool chips that open Whiskers & Co., and a lock on the buttons while the district is hot (with "Unlock anyway"). Crimes that count for a crew contract are marked in blue with the crew's progress.
- **Claw Street Ex (stocks):** logs every price you've seen and flags whether the current price looks low or high against its own history, over all of it, the last N days or above a floor you set per stock; a countdown to the next price tick and perk timing.
- **Tuna and catnip prices:** under each in the sidebar, the Whiskers & Co. price now and its hourly range (normal prices), coloured by where it sits in the range (black = top 25%, red, yellow, green = lowest 25%), with gold bags near the lowest.
- **XP bar:** the exact XP under the sidebar's XP bar ("2,519 / 2,900 XP · 381 to go").
- **Sidebar timers** (every page): a light-blue crew box with the crew's +5% bonus timer, your crew job's countdown if one's running and this week's crew contracts with their progress, a heist countdown while you're in one, companion care reminders (feed/groom/errand), PvP status (mug protection and any bounty on you), Premium tuna/Catnip tea cooldowns, a stock tick countdown, a cat clock with the daily reset, and a bank pill when a deposit is ready to collect, and Cat Café pet/brush timers.
- **Heists & Crew pages:** exact XP/energy, XP/nerve, $/energy, $/nerve for every heist and every crew job tier.
- **Investment Tracker (Claw Street Ex):** tracks money put into and pulled out of crew stock investments, and what's actually been made.
- **Cat Tree:** lock any stat so the Train button can't train it by accident; auto-lock (on by default) locks the stats your current gym trains slower than its best. Unlocking is one click.
- **Players page:** a green 💰 beside cats the crew has mugged for over $1,000 at least twice (from the crew attack log and your own attacks); and "🛡️ ready 04:12" beside a cat the crew or you mugged that is still safe from muggers (one hour after a mug); "½ XP until 1:45 AM" for 3 hours after you attack a cat; "took $2,450" beside the game's own "Hit you" tag when that cat took money from you; and ⚔️ for cats seen in a fight, with their last-seen level, weapons and armour on hover (also on their profile). Battle stats show only for cats whose players chose to share them, with the date they were last updated (Share my battle stats on the Account page; "⚔️ 3,924 · DEX/SPD": total, then the two biggest). Nobody else's battle stats are ever kept.
- **Pier Nine:** a sidebar row with fish left to keep today, your bucket's value, when the first fish goes off and when the tide turns (learned from the tide changes it sees); on the pier, a table of every fish with where it bites, on what tide and time of day, its average price and weight range (the whole crew's catches with crew sharing on, else yours).
- **Crew → Contracts (crew sharing on):** under each crime contract, the crew's cut of the cash reward and each member's share of the rest by how many of the crimes they did, yours first, with ✅ for shares the leaders have paid.
- **Trading page:** the cheapest currently-open listing for every item, next to Whiskers & Co.'s own buy price (tax included) and what it pays to sell the item back — flagging both an underpriced listing not worth skipping and a listing cheap enough to buy and immediately resell for a profit.
- **Whiskers & Co.:** the price range for items whose price changes hourly, and your discounted price.
- **Account page:** the script's settings, Share my battle stats (any crew or none, off unless you turn it on, seen by the Cataclysm alliance only; for alliance members a sidebar reminder under the crew contracts links there and can be switched off), and the optional game API key.
- **Records on your computer:** stock prices you've seen and a log of your Mews events (crime results, trades, heists, training and so on), so the game's real rates can be worked out. It never runs on a timer and never requests a page for you.

## Sharing (on unless you turn it off)

The script shares what you see with the Discord bot of The Purrfessionals (the maintainer's crew). It is on unless you turn it off on the Account page. Everyone sends the city data they see: stock prices, Whiskers & Co.'s hourly prices for Premium tuna and Catnip tea, the feats and crime mastery unlocks you have reached, the gear of cats seen in your fights, your own level and worn gear (your battle stats only if you turn on Share my battle stats; untick it and they are taken back, or turn sharing off and the last ones you shared stay, with their date), and your Pier Nine catches, with your cat id. Everyone gets the pooled data back, except other cats' gear and the battle stats members chose to share, which only the crews of the Cataclysm alliance get. Members of The Purrfessionals also send, and get, the crew features below. For them the script sends: the crew chain and its end time, the crew's active jobs (seats, members' names and levels, payout), the stock prices you've seen, the feats you've earned, the gear of other cats seen in your fights, the highest cat id you've seen on the Players page (so the leaders' recruiting list knows how many cats there are), the crew contracts' cash rewards from the Crew → Contracts tab (so leaders can work out each member's share), and the treasury's payments to members from the Crew page (who, how much, when; so contract pay is ticked off once it's sent), the crew's finished chains from the chain history (each cat's links, crimes and fights, by name) and the results of heists you were in (each member's payout, by name), your Pier Nine catches (fish, weight, price, spot, tide, day or night) with the fish book's notes and your Harbour sense, the crime mastery unlocks you have reached, and, only if the leaders entered a 💳 bank loan for you, your open bank deposits (amount, rate, end time). In return you get the crew's shared stock price history, how to get hidden feats a crewmate has found, what mastery unlocks do, contract payouts, the crew's last-seen gear for other cats, the crew's fish table, and crew jobs and heists posted to the crew's Discord by the bot, with a ⛓️ report when a chain ends and a ✅ result under each heist it posted. The crew's money features (contracts, treasury, loans, deposits) take data from members of The Purrfessionals only; the bot refuses them from anyone else. Nothing is ever sent to MeowStreets, and nothing about your account (cash, email, messages) is sent anywhere.

## Game API key (optional)

MeowStreets has an official read-only API for tools ("A key only ever reads"). If you want, make a **Public** key under Account in the game, name it after this script, and paste it into the script's box on the Account page. What it does and keeps:

- **Reads:** only `/api/v1/cat/<id>` for cats on the Players list that the game shows as lying low, to show their exact "🛡️ ready" time from the game's own shield time. At most one read every 3 seconds; each cat is remembered for 5 minutes, in memory only.
- **Keeps:** the key, in your userscript manager's storage on your computer. It is sent only to meowstreets.com, never to the crew bot or anyone else, and is never shown again once saved.
- **Who sees it:** only you.
- **Stop:** press Remove in the script's box, and revoke the key under Account in the game.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. Open this link and Tampermonkey will offer to install the script:
   **https://raw.githubusercontent.com/tcstrayben/Meowstreetscript/main/meowstreets-info.user.js**
   (or open `meowstreets-info.user.js` in this repository and press "Raw".)
3. Open MeowStreets. The script only runs on `https://meowstreets.com/`.

The script updates itself when a new version is published here (Tampermonkey checks about once a day, or press "Check for userscript updates" in its dashboard for an update right away). **Your recorded data is never affected by an update** — Tampermonkey keeps it tied to the script's name, not its version, so updating (automatic or by reinstalling from the same link) never clears anything you've logged.

**Tip:** the script reads the game data each page already loads, so there is nothing you need to open first. Crew contract details (what an attack contract counts, your own share) appear once you have opened Crew > Contracts that week.

## Contributing

Bug reports and ideas are welcome as issues. The maintainer notes are in [SETUP.md](SETUP.md).

## Licence

MIT, see [LICENSE](LICENSE).
