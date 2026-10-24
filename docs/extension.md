# Installing the Chrome extension

Until the extension is in the Chrome Web Store, load it unpacked:

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/` folder of this repository.
3. Pin Reviews42 from the puzzle icon, open its popup, enter your server (e.g. `https://reviews42.example.com`)
   and a token from the server's **Settings** page, then press **Connect**.
4. Chrome asks to allow the extension to reach your server: allow it.

Open any pull request's **Files changed** tab on GitHub. If your team uploaded notes for it, they appear next to the
diff, and the toolbar badge shows how many.

After `git pull`, press the reload icon on the extension's card in `chrome://extensions`.
