# MeowStreets Extra Info

A userscript that adds extra information to [MeowStreets](https://meowstreets.com). It reads what the page already shows (and the JSON the game's own pages fetch from their own API) and draws numbers next to it. It never plays for you.

> **Unofficial.** Not made by or affiliated with MeowStreets. Their terms ban "bots, scripts or automation that play for you". This script is display-only: it makes no requests to the game, clicks nothing and presses nothing. Read the game's own rules and decide for yourself.

## What it shows

- **Crimes page:** exact success % for every crime, broken down (base, mastery, merits, education, crew bonus, perks, heat); exact XP and cash per nerve; item drop odds; heat warnings; the best crimes highlighted.
- **Claw Street Ex (stocks):** logs every price you've seen and flags whether the current price looks low or high against its own history; a countdown to the next price tick and perk timing.
- **Sidebar timers** (every page): crew chain countdown (plus your crew job's countdown if one's running), a heist countdown while you're in one, companion care reminders (feed/groom/errand), PvP status (mug protection and any bounty on you), Premium tuna/Catnip tea cooldowns, and a stock tick countdown.
- **Heists & Crew pages:** exact XP/energy, XP/nerve, $/energy, $/nerve for every heist and every crew job tier.
- **"Copy for Discord" (Crew and Heists pages):** while you're actually in a crew job and/or a heist, a ready-to-paste message per one — who has a seat, which are open (and what stat each wants, for crew jobs), the minimum level, and the payout — with a button that copies it to your clipboard. In more than one at once, a tab per job/heist lets you switch which message is shown.
- **Investment Tracker (Claw Street Ex):** tracks money put into and pulled out of crew stock investments, and what's actually been made.
- **Cat Tree:** a lock toggle next to each stat's Train button, so a stat you don't want trained can't be clicked by accident — unlocking it is just as instant.
- **Trading page:** the cheapest currently-open listing for every item, next to Whiskers & Co.'s own buy price (tax included) and what it pays to sell the item back — flagging both an underpriced listing not worth skipping and a listing cheap enough to buy and immediately resell for a profit.
- **Account page:** a settings panel with two switches for what gets recorded, and an Export data button.
- **Records what you view:** each page you open is saved on your computer once it has settled (never account, payment or other players' pages, and never chat), plus a log of your Mews events (crime results, trades, heists, training and so on) so the game's real rates can be worked out. It never runs on a timer and never requests a page for you.
- **Export:** a button that saves everything the script has logged to a `.json` file on your computer.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. Open this link and Tampermonkey will offer to install the script:
   **https://raw.githubusercontent.com/tcstrayben/Meowstreetscript/main/meowstreets-info.user.js**
   (or open `meowstreets-info.user.js` in this repository and press "Raw".)
3. Open MeowStreets. The script only runs on `https://meowstreets.com/`.

The script updates itself when a new version is published here (Tampermonkey checks about once a day, or press "Check for userscript updates" in its dashboard for an update right away). **Your recorded data is never affected by an update** — Tampermonkey keeps it tied to the script's name, not its version, so updating (automatic or by reinstalling from the same link) never clears anything you've logged.

**Tip:** the script only knows what you have opened. The checklist at the top of the sidebar shows which pages to visit (Merits, Education, Crew and its Perks tab). Keep the Crew page fresh, because the crew chain dies after 30 minutes without a crime.

## Contributing

Bug reports and ideas are welcome as issues. The maintainer notes are in [SETUP.md](SETUP.md).

## Licence

MIT, see [LICENSE](LICENSE).
