# iOS Background Keeper

SillyTavern extension that starts a muted video-only keeper stream and asks Safari/WebKit to put it into Picture in Picture.

The goal is to avoid the old silent-audio trick, because external music apps can interrupt that audio session on iOS. This extension uses a canvas video stream with no audio track, so it is less likely to fight with music playback.

Notes:

- Tap `Start PiP` from the extension panel after the page loads.
- iOS usually requires a user gesture before playback or Picture in Picture can start.
- Home Screen web apps may expose fewer PiP controls than Safari tabs on some iOS versions.
- This is a browser-level workaround, not a native ActivityKit/Dynamic Island implementation.
