# SillyTavern - Latest Added Card Slot

A lightweight SillyTavern UI extension that pins a dedicated **"Latest Added Card"** slot at the very top of the Character Management list — right below the pagination arrows and above your tag folders/groups.

No more searching for cards you literally just imported when your character list is sorted by **Recent** or when imported tags automatically hide new cards inside tag folders.

## Features

- **Pinned Top Slot**: Appears at the very top of `#rm_print_characters_block` (right after the pagination controls and above tag folders/groups).
- **Instant Import Detection**: Automatically tracks newly imported or created characters (file import, drag-and-drop, external URL import, or folder additions) and pins the newest card to the top slot.
- **Stays on Page 1 on Import**: Prevents SillyTavern from jumping to the last page when importing a card while sorted by `Recent`.
- **Recently Added History (`<` `>`)**: Step backward and forward through your most recently added cards if you import multiple cards in a batch.
- **Collapsible**: Click the slot header or chevron to collapse/expand the slot at any time.

## Installation

1. Open **SillyTavern** and go to **Extensions** -> **Install Extension**.
2. Paste the repository URL:
   ```
   https://github.com/LukaTheHero/SillyTavern-LatestAddedCard
   ```
3. Click **Install**.
