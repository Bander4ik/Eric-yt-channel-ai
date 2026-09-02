# How to update the app

When the developer ships fixes or new features, you'll need to download the new version of the project files. Your saved data — API keys, channels, competitors, transcripts, chat history — lives in a separate folder in your **home** folder (`~/.youtube-channel-ai-vip`), not in the project folder. Replacing, renaming or deleting the project folder cannot touch it.

This guide assumes you've **never written code, never used a terminal, never used GitHub**. Every step is spelled out. Take your time — a normal update takes 5-10 minutes.

> **If anything looks weird or doesn't match what's on your screen, STOP and screenshot it.** Send the screenshot to the developer with a short note saying which step you're on. Don't guess.

### If you installed before August 2026, read this once

Older versions kept your data in a `data` folder **inside** the project — which meant that deleting the project folder deleted everything with it. That is fixed, but the move happens on the first launch of this version:

- Start the new version **once from your existing folder** (or copy the old `data` folder into the new one, as the old guide said) so the app can see your data and move it out to your home folder. It prints a line in the terminal saying where it went, and leaves a `READ-ME-FIRST.txt` in the old spot.
- After that one launch, you never have to think about it again — update however you like.

If you already deleted an old project folder and your data went with it, don't start re-entering things yet: message the developer first, it's often recoverable.

---

## Before you start — fix the OneDrive problem (if it applies to you)

Open the folder where your project currently lives. **If the path contains `OneDrive`, `iCloud Drive`, `Dropbox`, or `Google Drive`** — you need to move it before doing anything else.

**Why this matters:** cloud-sync services constantly copy file changes to the internet, and they fight with the installer — it writes thousands of small files into `node_modules`, and OneDrive grabbing them mid-write is the single most common cause of an install that fails with permission errors or an app that behaves strangely afterwards.

(Your database is no longer at risk from this — it lives in your home folder now, outside anything OneDrive syncs. The install itself still is.)

**How to fix:**

1. Make sure the app is **not running** (close any `start.bat` terminal window).
2. Open **File Explorer** (yellow folder icon on the taskbar).
3. Find your current project folder. Likely path: `OneDrive\Desktop\YouTube-Channel-AI-VIP-main` or similar.
4. Pick a new safe home for it. Good options:
   - `C:\YouTube-Channel-AI-VIP` (right at the root of your C: drive — this is never synced)
   - `C:\Users\<your-name>\Documents\YouTube-Channel-AI-VIP` (only if your `Documents` folder does NOT show a small cloud icon next to it; if it does, use the first option)
5. **Drag the entire project folder** from its current location to the new location.
6. Done. From now on, run `install.bat` and `start.bat` from the new location, not the old one.

If your project is already outside of any synced folder, you can skip this section.

---

## Which update path is yours?

There are two ways people first installed the app. Figure out which is yours so you follow the right section:

- **Did you download a ZIP file from GitHub** (or get one from the developer), unzip it, and run `install.bat` / `start.bat` from inside that folder? → **Use Path A: ZIP update** below.
- **Did you install "GitHub Desktop"** and clone the project through it? → **Use Path B: GitHub Desktop update** below.
- **Not sure?** Look inside your project folder. If you see a hidden folder called `.git` (you may need to enable "Show hidden items" in File Explorer's View menu), you're on Path B. If not, you're on Path A.

---

## Path A — Update via fresh ZIP download (no extra tools needed)

This is the simpler path on the day-of, but you have to repeat it every time. If you find yourself updating more than once or twice, please read the **"Switch to GitHub Desktop"** section at the very bottom of this guide — it makes future updates one-click.

### Step 1. Stop the app

If the app is currently running, you'll see a **black terminal window** somewhere on your screen — it was opened when you double-clicked `start.bat`. **Close that terminal window** (click the X in its top-right corner). The app's server is now off.

You can leave the browser tab open — the app's webpage will just say "site can't be reached" once the server stops. That's expected.

### Step 2. Rename your current project folder

Nothing of yours is inside it any more, so this is purely a safety net: if the new version misbehaves you can go back to the old one in five seconds.

1. Open **File Explorer**.
2. Navigate to where your project folder lives.
3. Right-click on the project folder (e.g. `YouTube-Channel-AI-VIP-main`) → **Rename**.
4. Add `-old` to the end of the name. Example: `YouTube-Channel-AI-VIP-main` becomes `YouTube-Channel-AI-VIP-main-old`.
5. Press **Enter** to confirm.

### Step 3. Download the new ZIP

1. Open this link in your web browser:
   **[https://github.com/YT-Wizards/YouTube-Channel-AI-VIP](https://github.com/YT-Wizards/YouTube-Channel-AI-VIP)**
2. Above the file list near the top of the page, find the **green `<> Code` button** and click it.
3. In the dropdown menu that opens, click **Download ZIP** (at the bottom).
4. A ZIP file starts downloading. It will be named `YouTube-Channel-AI-VIP-main.zip` and lands in your **Downloads** folder.

### Step 4. Extract the new ZIP

1. Open your **Downloads** folder in File Explorer.
2. Find the new ZIP file → right-click → **Extract All...**
3. Click **Extract**. A new folder appears next to the ZIP, called `YouTube-Channel-AI-VIP-main`.
4. **Move this new folder to the same safe location as the `-old` one.** (Drag-and-drop is fine.) You should now have both folders side by side:
   - `YouTube-Channel-AI-VIP-main` (the new one — fresh code)
   - `YouTube-Channel-AI-VIP-main-old` (the old one — spare copy of the code, nothing of yours in it)

### Step 5. Nothing to copy

There used to be a step here about copying a `data` folder across, and skipping it cost people everything they'd set up. It's gone: your data isn't in the project folder any more, so there's nothing to move. Straight on to the next step.

(The one exception is the very first launch after upgrading from a pre-August-2026 version — see the note at the top of this guide.)

### Step 6. Re-install dependencies (just in case)

The developer sometimes adds new code libraries that the app needs. Running the installer again is a no-op if nothing changed, and quick if something did.

1. Inside the new project folder, find **`install.bat`** → double-click it.
2. A black terminal window opens. Lots of text scrolls past — that's normal.
3. **Wait** until it shows `Installation complete!` and `Press any key to continue...`.
4. Press any key to close the window.

Typical time: 30 seconds to 2 minutes.

### Step 7. Start the new version

1. Inside the new project folder, double-click **`start.bat`**.
2. A new black terminal window opens. After 5-10 seconds you'll see lines like:
   ```
   ▲ Next.js 16.2.4
   - Local:        http://localhost:3000
   ✓ Ready in 283ms
   ```
3. Your browser should automatically open to `http://localhost:3000`. If it doesn't, open your browser yourself and go to that address.

### Step 8. Hard-refresh your browser (CRITICAL)

Your browser caches the app's code to make it load faster — but right after an update, the cached version is outdated and might still show the bugs we just fixed. We need to force a fresh load.

1. Click anywhere on the app's webpage so the browser tab is focused.
2. Press **Ctrl + Shift + R** (hold all three at once). On Mac: **Cmd + Shift + R**.
3. The page reloads. You're now on the new version.

> **If you skip this step**, you might still see the old version and think the update didn't work. Don't skip it.

### Step 9. Verify your data is intact

1. Click **Integrations** in the left sidebar → confirm your API keys are still there (the green "Connected" chips).
2. Click **Dashboard** → confirm your channel(s) are still listed.
3. Pick a video → confirm the transcript (if you had one) is still there.

If all three look right, **delete the `-old` folder** to free up disk space. You're done!

If something is missing, screenshot what you see and ask the developer before changing anything. Your data is still sitting in `~/.youtube-channel-ai-vip` regardless of what the screen says — a blank-looking app after an update is almost always the browser showing you a cached page (Step 8) or the app reading a different folder, not data that's gone.

---

## Path B — Update via GitHub Desktop

If you installed GitHub Desktop to clone the project initially, updates are dramatically simpler.

### Step 1. Stop the app

Close the **black terminal window** that's running the app's server. The app is now off.

### Step 2. Open GitHub Desktop

Find GitHub Desktop in your Start menu and open it.

### Step 3. Fetch and pull

1. At the top of GitHub Desktop, make sure the **"Current repository"** dropdown (top-left) shows `YouTube-Channel-AI-VIP`. If it doesn't, click the dropdown and pick it.
2. Look for the **Fetch origin** button near the top (or sometimes labeled "Fetch"). Click it.
3. GitHub Desktop checks the project on GitHub for any new changes. After a second or two, the button changes:
   - If it says **"Pull origin"** with a downward arrow and a number (e.g. "Pull origin · 3 commits behind") → there are new changes. Click it.
   - If it says **"Fetch origin"** unchanged with no number → you're already up to date. Nothing else to do, skip to Step 5.

GitHub Desktop downloads the new files into your existing project folder. Your data isn't in there, so there is nothing to preserve.

### Step 4. Re-install dependencies (just in case)

Same as Path A Step 6 — open the project folder, double-click `install.bat`, wait for it to finish.

### Step 5. Start the new version

Double-click `start.bat`. The app launches like before.

### Step 6. Hard-refresh your browser

**Ctrl + Shift + R** (or **Cmd + Shift + R** on Mac) on the app's tab. Don't skip this.

### Step 7. Verify your data

Same as Path A Step 9. Check Integrations, Dashboard, a video. Everything should be intact — an update only ever replaces code.

You're done!

---

## Recommended: switch from ZIP to GitHub Desktop

If you've been using Path A (ZIP downloads), please consider switching to Path B (GitHub Desktop) for future updates. The setup takes about 10 minutes once, and after that every update is **3 clicks** instead of the 8 steps above.

### Why switch?

- **One-click updates.** Open GitHub Desktop → click Fetch → click Pull. That's it.
- **No re-download needed.** It only fetches what changed, not the whole project. Usually a few KB instead of 50+ MB.
- **Nothing to unzip, move, or rename.** Fewer moving parts is fewer things to get wrong.
- **You get to keep your current data, settings, everything.** The switch doesn't reset anything.

### How to switch

#### Step 1. Install GitHub Desktop

1. Open this link in your browser: **[https://desktop.github.com/](https://desktop.github.com/)**
2. Click the big purple **Download for Windows** button (it auto-detects your OS).
3. The installer downloads — once it finishes, double-click it. It installs and opens automatically.

You can sign in with a GitHub account or skip the sign-in step — both work for our public repo. If you don't have an account and don't want to make one, just skip.

#### Step 2. Clone the repository

1. In GitHub Desktop, click **File → Clone repository...** (or press **Ctrl + Shift + O**).
2. A window opens with three tabs at the top. Click the **URL** tab.
3. In the box labeled "Repository URL", paste:
   ```
   https://github.com/YT-Wizards/YouTube-Channel-AI-VIP
   ```
4. **Local path**: this is where the project will live on your computer. The default (something like `C:\Users\<your-name>\Documents\GitHub\YouTube-Channel-AI-VIP`) is fine **as long as Documents is not OneDrive-synced**. If it is, click **Choose...** and pick a non-synced location instead (e.g. `C:\YouTube-Channel-AI-VIP-git`).
5. Click **Clone**. GitHub Desktop downloads the project. Takes 10-30 seconds.

#### Step 3. Nothing to bring across

Your data lives in your home folder, not in the project — the fresh clone will find it on its own.

Only if you're coming from a version older than August 2026 and have **never launched the new one**: start the app once from your old folder first, so it can move your data out. Then come back here.

#### Step 4. Install + start in the new folder

1. Inside the new folder, double-click **`install.bat`**. Wait for "Installation complete!".
2. Double-click **`start.bat`**.
3. Browser opens. **Ctrl + Shift + R** to hard-refresh.

#### Step 5. Verify and clean up

Check that Integrations, Dashboard, and a video all show your data. If everything is intact, you can delete your old ZIP-installed project folder.

From now on, every update is just:
1. Close the terminal window (stop the app)
2. Open GitHub Desktop → **Fetch origin** → **Pull origin**
3. Double-click `start.bat`
4. **Ctrl + Shift + R** in the browser

---

## Troubleshooting

### "I don't see a green `<> Code` button on GitHub"

You might be looking at a specific file inside the repository instead of the main page. Make sure the URL bar just shows `https://github.com/YT-Wizards/YouTube-Channel-AI-VIP` (with no extra path after it). If it has `/blob/`, `/tree/`, or anything else after `YouTube-Channel-AI-VIP`, click the repository name at the very top to go back to the main view.

### "install.bat failed with an error"

Check the last few lines of the black terminal window before it closed:

- **"Node.js is not installed"** — install Node.js 20+ from [nodejs.org](https://nodejs.org/) (the green "LTS" button), then re-run `install.bat`.
- **"python not found"** or **"youtube-dl-exec needs Python"** — install Python from the Microsoft Store (search for `Python 3.12`, click Get / Install), then re-run `install.bat`.
- **Any other red text** — screenshot it and ask the developer.

### "The black terminal window flashed and closed too fast for me to read it"

This means there was an error and the script gave up. To see the error message:

1. Open File Explorer, navigate to your project folder.
2. Hold the **Shift** key on your keyboard, **right-click in an empty area** of the folder (not on a file).
3. From the menu, pick **Open in Terminal** (or **Open PowerShell window here**).
4. Type `.\install.bat` and press Enter (or `.\start.bat` if you were running that one).
5. The window stays open this time — you can read the error.

### "The app shows the old version even after I updated"

You probably skipped the hard-refresh. Click the app's browser tab, then press **Ctrl + Shift + R** (or **Cmd + Shift + R** on Mac). If that doesn't work, close the entire browser and reopen it.

### "My API keys / channels are missing after the update"

Don't re-enter anything yet — your data is almost certainly still there. In order of likelihood:

1. **The browser is showing you a cached page.** Hard-refresh: **Ctrl + Shift + R** (**Cmd + Shift + R** on Mac). This is the most common cause by a wide margin.
2. **You're upgrading from a pre-August-2026 version and launched a fresh folder that never saw your old data.** Start the app once from your **old** folder instead so it can move your data across, then go back to the new one.
3. **A `DATA_DIR` setting is pointing the app somewhere else.** Check for a `.env` file in the project folder.

Check that `~/.youtube-channel-ai-vip/app.db` exists and isn't tiny (it should be megabytes, not kilobytes). If it's there, nothing is lost — message the developer with a screenshot rather than starting over.

### "Port 3000 is already in use" (or "EADDRINUSE")

You have another `start.bat` running somewhere, or another app is using that port. Look for any extra black terminal windows on your taskbar and close them. If that doesn't help, restart your computer — that always frees the port.

If it is a different app you genuinely need running at the same time (our faceless-video generator also uses 3000), create a text file called `port.txt` next to `start.bat` containing just a number such as `3001`. The launcher will use that port from then on. If you use Google login, add the matching redirect URI in Google Cloud too — the Integrations page shows the exact line.

---

## Summary card (keep this handy)

**Update via ZIP (Path A):**
1. Stop the app (close terminal)
2. Rename current folder to add `-old`
3. Download fresh ZIP from [github.com/YT-Wizards/YouTube-Channel-AI-VIP](https://github.com/YT-Wizards/YouTube-Channel-AI-VIP) (green Code button → Download ZIP)
4. Extract to the same safe location as `-old`
5. Run `install.bat` → wait for "Installation complete!"
6. Run `start.bat`
7. **Ctrl + Shift + R** in the browser
8. Verify data is intact, delete `-old`

**Update via GitHub Desktop (Path B):**
1. Stop the app
2. GitHub Desktop → Fetch origin → Pull origin
3. Run `install.bat`
4. Run `start.bat`
5. **Ctrl + Shift + R** in the browser

**Never:**
- Update without closing the running app first
- Skip the hard-refresh (`Ctrl + Shift + R`)
- Keep the project inside OneDrive / iCloud / Dropbox
- Delete `~/.youtube-channel-ai-vip` — *that* folder is your data. The project folder is just code and can be replaced freely.
