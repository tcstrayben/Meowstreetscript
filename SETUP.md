# Setup notes for the maintainer

Steps to publish this folder as a GitHub repository, turn on the data bot, and check it works. Nothing in here has been published yet.

## Before you publish

- **Ask MeowStreets first.** Their terms ban scripts that "play for you". This one is display-only, but a public link makes it much easier to find, and the shared stock history sends data to GitHub (only when a user presses a button). Emailing support@meowstreets.com and asking whether display-only scripts are allowed, and whether there is an official API, is the safe order of things.
- **Decide the repository name.** This one is `Meowstreetscript`.

## 1. Create the repository

1. On github.com, create a new repository. It must be **public**: Tampermonkey and the script's "Load shared history" button read raw files without logging in, and private repositories cannot do that.
2. Upload everything in this folder (drag it into "Add file, Upload files", or use git). Keep the folder structure: `.github/`, `data/`, `scripts/`, the script and the docs.
3. **Do not upload** personal exports (`meowstreets-data-*.json`, they are also in `.gitignore`), screenshots, `meowstreets-data.md` or the changelog from the working folder. They contain your own account's numbers.

## 2. Turn on what the bot needs

1. **Settings, Actions, General, Workflow permissions:** choose **Read and write permissions**. The bot commits `data/stocks.json` and closes issues with it.
2. **Settings, General, Features:** make sure **Issues** is ticked.
3. Optional but recommended: **Settings, Moderation options** lets you limit who can open issues for a while if you ever get spam.

## 3. The script already points at this repository

`meowstreets-info.user.js` is set up for `tcstrayben/Meowstreetscript`: the `GITHUB_REPO` constant and the `@updateURL` / `@downloadURL` header lines already use it. From now on, raising the `@version` number and committing the new file is a release: everyone's Tampermonkey picks it up within a day.

If you ever move or rename the repository, change those three places.

## 4. Check it end to end

1. Install the script from its raw address.
2. Open a Claw Street Ex page and press **Load shared history**. It should say how many periods it loaded.
3. Press **Contribute stock data**. A GitHub page opens with the data already copied: paste it between the two lines and submit.
4. Within about a minute the bot should reply on the issue with what it added, close it, and `data/stocks.json` should have a new commit. (Look at the **Actions** tab if not.)

## Running things locally

- Tests: `node --test scripts/merge-stock-data.test.js`
- Try a submission without GitHub: save the issue text to a file, then `node scripts/merge-stock-data.js --file body.txt someusername`. It updates `data/` and writes `result.md`.

## Looking after the data

- **Bad data:** every change is a commit, so you can revert one in the GitHub interface. The most-voted price wins, and prices far out of line are refused.
- **A new stock:** the bot only accepts stock ids already in `data/stocks.json`. To add one, add an entry with an empty `"prices": {}` (the id is the last part of its Claw Street Ex address, such as `nine`).
- **Size:** about 100 bytes per price period per stock. A year of every period for six stocks is roughly 4 MB. Votes older than 30 days are dropped from `data/voters.json` automatically.
- **Privacy:** `data/voters.json` stores only a short hash of each contributor's GitHub name per period, and is used to stop one person voting twice.

## Keeping the working copy and the repo copy in step

The repository copy of the script is a copy of the one in the working folder. When the script changes, copy it over again and check that the repository name and the two header lines from step 3 are still in it.
