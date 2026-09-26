# MeowStreets Extra Info

A userscript that adds extra information to [MeowStreets](https://meowstreets.com). It reads what the page already shows and draws numbers next to it. It never plays for you.

> **Unofficial.** Not made by or affiliated with MeowStreets. Their terms ban "bots, scripts or automation that play for you". This script is display-only: it makes no requests to the game, clicks nothing and presses nothing. Read the game's own rules and decide for yourself.

## What it shows

- **Crimes:** exact XP per nerve and cash per nerve on every crime card, the best crime for XP and for cash highlighted, the item each crime can drop, heat warnings (half XP and no clean jobs above 80 heat), and a line showing **where each point of the success % comes from** (base, mastery, merits, education, crew bonus, crew perk, heat).
- **Claw Street Ex (stocks):** logs every price move and tells you if a price looks low or high against what has been recorded (see "Shared stock history" below).
- **Sidebar:** a countdown to the next stock price move, your crew chain timer (it goes red if you have not looked at the Crew page in 20 minutes), and a "Script data" checklist showing which pages the script has read recently.
- **Cat Tree and Mews:** logs happiness and training gains so the game's formulas can be worked out.
- **Records what you view:** each page you open is saved on your computer once it has settled (never account, payment or other players' pages, and never chat), plus a log of your Mews events (crime results, trades, training and so on) so the game's real rates can be worked out. It never runs on a timer and never requests a page for you.
- **Export:** a button that saves everything the script has logged to a `.json` file on your computer.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. Open this link and Tampermonkey will offer to install the script:
   **https://raw.githubusercontent.com/tcstrayben/Meowstreetscript/main/meowstreets-info.user.js**
   (or open `meowstreets-info.user.js` in this repository and press "Raw").
3. Open MeowStreets. The script only runs on `https://meowstreets.com/`.

The script updates itself when a new version is published here (Tampermonkey checks about once a day).

**Tip:** the script only knows what you have opened. The checklist at the top of the sidebar shows which pages to visit (Merits, Education, Crew and its Perks tab). Keep the Crew page fresh, because the crew chain dies after 30 minutes without a crime.

## Shared stock history (optional, and only when you press a button)

Stock prices are the same for every player, so they are safe to share. Each person only records prices while their tab is open. Put together, everyone's records give a much fuller history, so "looks low" and "looks high" become more trustworthy.

On the Claw Street Ex page the script adds two buttons:

- **Load shared history** downloads `data/stocks.json` from this repository (one request to `raw.githubusercontent.com`) and fills the gaps in your own record.
- **Contribute stock data** copies your logged prices and opens a GitHub page. You paste them, press "Submit new issue", and a bot merges them into the data file in about a minute.

Nothing happens unless you press a button. **What is sent:** stock ids, 15-minute period numbers and whole-dollar prices. **What is never sent:** crime data, merits, cash, chat, your name or anything else from your game. A GitHub issue is public and shows your GitHub username; the prices in it are the same for everyone.

**How bad data is handled:** every contributor gets one vote per price period and the price with the most votes wins. Prices that are far out of line with their neighbours are rejected. See `scripts/merge-stock-data.js` and its tests. Nothing in a submission is ever run as code.

## Contributing code

Bug reports and ideas are welcome as issues. Run the tests with `npm test` (needs Node 20 or newer). The maintainer notes are in [SETUP.md](SETUP.md).

## Licence

MIT, see [LICENSE](LICENSE).
