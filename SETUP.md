# Setup notes for the maintainer

This repository is already published at `tcstrayben/Meowstreetscript`. These notes are for publishing a new version.

## Publishing an update

1. In the working folder, bump `@version` in `meowstreets-info.user.js` and finish testing it there (`dev-tests/run-all.sh`).
2. Copy the finished file over this repository's `meowstreets-info.user.js`. Keep the four header lines that only belong in this published copy (not the working one): `@homepageURL`, `@supportURL`, `@updateURL`, `@downloadURL` — they already point at `tcstrayben/Meowstreetscript`, so nothing else needs changing there.
3. Commit and push. Everyone's Tampermonkey picks up the new version within a day (or right away if they press "Check for userscript updates").

If the repository is ever renamed or moved, update those same four header lines (and this file).

## Before it was first published

- **Asked MeowStreets first.** Their terms ban scripts that "play for you". This one is display-only, but a public link makes it much easier to find. Emailing support@meowstreets.com and asking whether display-only scripts are allowed, and whether there is an official API, is the safe order of things — still not answered as of this repo's last update.
- The repository must stay **public**: Tampermonkey reads the raw script file without logging in, and a private repository cannot do that.

## What used to be here

An earlier version of this script (0.13.0) had a GitHub-issue-based bot for pooling everyone's stock price history. It was dropped when the script moved to reading the game's own `/api/state` data directly (0.14.4 onward), which gives exact prices and history without needing anyone to submit anything.
