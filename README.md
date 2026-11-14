# MeowStreets Extra Info

A userscript that adds extra information to [MeowStreets](https://meowstreets.com). It reads what the page already shows (and the JSON the game's own pages fetch from their own API) and draws numbers next to it. It never plays for you.

> **Unofficial.** Not made by or affiliated with MeowStreets. Their terms ban "bots, scripts or automation that play for you". This script is display-only: it clicks nothing and presses nothing. It only sends or asks for anything if you verify for sharing with a game API key (see below). Read the game's own rules and decide for yourself.

## What it shows

- **Crimes pages:** on the street, a table of the best place in each job (the game's odds there, expected $ and XP per nerve, mastery and successes to the next level). On each job's page: expected $ and XP per nerve and what it pays when it works, the game's success % with where every point comes from (the game's own list of your bonuses), heat and when it is back to 0, what the mastery unlocks do, tool chips that open Whiskers & Co., and a lock on the buttons while the district is hot (with "Unlock anyway"). Crimes that count for a crew contract are marked in blue with the crew's progress. Expected per nerve = what it pays when it works × the place's odds (a failure pays nothing), plus the clean-job chance; each mastery level adds +1 odds, +2.5% pay and +1 clean-job chance. A clean job's extra is learned from your own Mews results once there are 3, else ×1.5.
- **Claw Street Ex (stocks):** logs every price you've seen and flags whether the current price looks low or high against its own history, over all of it, the last N days or above a floor you set per stock; a countdown to the next price tick and perk timing.
- **Tuna and catnip prices:** under each in the sidebar, the Whiskers & Co. price now and its hourly range (normal prices), coloured by where it sits in the range (black = top 25%, red, yellow, green = lowest 25%), with gold bags near the lowest.
- **XP bar:** the exact XP under the sidebar's XP bar ("2,519 / 2,900 XP · 381 to go").
- **Sidebar timers** (every page): a light-blue crew box with the crew's +5% bonus timer, your crew job's countdown if one's running and this week's crew contracts with their progress, a heist countdown while you're in one, companion care reminders (feed/groom/errand), PvP status (mug protection and any bounty on you), Premium tuna/Catnip tea cooldowns, a stock tick countdown, a cat clock with the daily reset, and a bank pill when a deposit is ready to collect, and Cat Café pet/brush timers.
- **Heists & Crew pages:** exact XP/energy, XP/nerve, $/energy, $/nerve for every heist and every crew job tier.
- **Investment Tracker (Claw Street Ex):** tracks money put into and pulled out of crew stock investments, and what's actually been made.
- **Cat Tree:** lock any stat so the Train button can't train it by accident; auto-lock (on by default) locks the stats your current gym trains slower than its best. Unlocking is one click.
- **Players page:** a green 💰 beside cats the crew has mugged for over $1,000 at least twice (from the crew attack log and your own attacks); and "🛡️ ready 04:12" beside a cat the crew or you mugged that is still safe from muggers (one hour after a mug); "½ XP until 1:45 AM" for 3 hours after you attack a cat; "took $2,450" beside the game's own "Hit you" tag when that cat took money from you; and ⚔️ for cats seen in a fight, with their last-seen level, weapons and armour on hover (also on their profile). Battle stats show only for cats whose players chose to share them, with the date they were last updated (Share my battle stats on the Account page; "⚔️ 3,924 · DEX/SPD": total, then the two biggest). Nobody else's battle stats are ever kept.
- **Purrgatory (jail):** for verified members of the Cataclysm alliance with sharing on, a mark beside each jailed cat: blue ✔ your crew, green ✔ another alliance crew, red ✖ not in the alliance (the crew is named on hover). The alliance member list comes from the MeowStreets Info server, refreshed at most every 15 minutes.
- **Pier Nine:** a sidebar row with fish left to keep today, your bucket's value, when the first fish goes off and when the tide turns (learned from the tide changes it sees); on the pier, a table of every fish with where it bites, on what tide and time of day, its average price and weight range (every script user's catches with sharing on, else yours).
- **Crew → Contracts (the maintainer's crew, Crew data on):** under each crime contract, the crew's cut of the cash reward and each member's share of the rest by how many of the crimes they did, yours first, with ✅ for shares the leaders have paid.
- **Trading page:** the cheapest currently-open listing for every item, next to Whiskers & Co.'s own buy price (tax included) and what it pays to sell the item back — flagging both an underpriced listing not worth skipping and a listing cheap enough to buy and immediately resell for a profit.
- **Whiskers & Co.:** the price range for items whose price changes hourly, and your discounted price.
- **Account page:** the script's settings: verifying with a Public game API key, and one switch for each kind of sharing (see Sharing below). Until you verify, a link under the sidebar's crew box points there; for alliance members a reminder to share battle stats sits there too and can be switched off.
- **Records on your computer:** stock prices you've seen and a log of your Mews events (crime results, trades, heists, training and so on), so the game's real rates can be worked out. It never runs on a timer and never requests a page for you.

## Sharing (verify first, then one switch per kind of data)

Sharing goes to the **MeowStreets Info server** (a small server run by the maintainer). Without verifying, nothing is sent anywhere and everything the script works out from your own pages still works.

**Verifying.** Make a **Public** key under Account → API in the game and paste it into the script's box on the Account page.

1. The script asks the game what kind of key it is (straight to meowstreets.com). **Self and Crew keys are refused** and never sent anywhere: they can see private things like your cash and Mews.
2. A Public key is sent once to the MeowStreets Info server, which asks the game who owns it.
3. The server gives your browser a private code and **throws the key away**, unless you tick **Use my key for data**. Every later send carries your cat id and that code, so nobody can share in your name. The server keeps only a scrambled copy of the code.

A Public key only sees what anyone can see on cats' and crews' public pages. The key also stays in your browser for one thing: the game's own shield time for lying-low cats on the Players list (🛡️ ready), at most one cat every 3 seconds, asked only of meowstreets.com. **Remove key** takes it out of your browser; **Stop sharing and forget me** turns sharing off and has the server drop your code. Revoke the key in the game whenever you like.

**The switches** (Account page, after verifying). Each one says what it sends and who gets it back:

| Switch | Sends (with your cat id) | Who gets it back |
|---|---|---|
| **City data** (on after verifying; needed for the rest) | stock prices as you view them, Whiskers & Co.'s hourly Premium tuna and Catnip tea prices, hidden feats you've earned, crime mastery unlocks you reach, your Pier Nine catches, the fish book's notes and your Harbour sense | **everyone verified**: pooled stock history, how to get hidden feats, what mastery unlocks do, the fish table, what the next Harbour sense levels do, which crewless cats are active |
| **Fight info** | the gear of cats seen in your fights, your own level and worn gear | **the Cataclysm alliance only**: other cats' last-seen gear and the battle stats players chose to share |
| **Share my battle stats** (off unless ticked) | your base strength, defense, speed and dexterity | **the Cataclysm alliance only**, with the date; untick to take them back |
| **Crew data** (the maintainer's crew only) | crew chain, active jobs, heists you're in, contract rewards, the treasury log, the bank's deposit rates, finished chains, heist results, the newest cat id on the Players page | that crew's leaders and Discord only |
| **Bank deposits** (off unless ticked; only shown to someone with a 💳 bank loan from that crew) | your open deposits (amount, rate, end time) | that crew's treasurers only |
| **Use my key for data** (off unless ticked) | nothing more from you: the server keeps your Public key and reads public cat and crew pages with it, taking turns with other keys | helps the server read faster |

Scripts that haven't verified yet keep sharing until 16 November 2026; after that they share nothing until they verify. Nothing about your account (cash, email, messages) is ever sent, and nothing is ever sent to MeowStreets.

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
