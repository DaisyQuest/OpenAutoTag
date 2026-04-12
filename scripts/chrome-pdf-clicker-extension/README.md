# PDF Link Clicker

This unpacked Chrome extension scans the current page for PDF links and opens every unique PDF in a background tab with one click.

## Load it in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder:
   `C:\Users\tabur\Videos\BuildEverything\scripts\chrome-pdf-clicker-extension`

## Use it

1. Open a page that contains PDF links
2. Click the extension icon
3. Press `Open PDF Links`

## Notes

- Links are deduplicated before opening.
- PDF detection is based on the resolved URL pathname ending in `.pdf`.
- The extension opens background tabs instead of doing literal same-tab clicks so the run does not stop after the first navigation.
