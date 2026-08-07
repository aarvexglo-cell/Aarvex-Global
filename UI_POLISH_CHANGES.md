Summary of UI polish changes

Files edited:
- portal.html
- ax-features.css
- ax-feed.css
- ax-social.css

What I changed
- Delivery: clarified radius helper text in `portal.html`.
- Track: added `.ax-track-strip` styling, spacing, and visual elevation.
- Claims: improved `.ax-claim-card` elevation, spacing, and leg grid readability.
- Shop: polished `.shop-hero-card`, `.shop-prod-card` image handling and hover states.
- Home feed: added subtle border/shadow to `.ax-feed-composer` and `.ax-post-card` hover effect.
- Messenger: improved `.ax-chat-topbar`, `.ax-chat-messages`, chat bubble padding/hover, composer input sizing, and inbox search styling.

Visual QA checklist (open the portal in a browser and verify):
- Delivery tab
  - Open Delivery -> Claims. Ensure the radius note reads: "Only orders whose pickup shop is within your radius appear here..." and no missing UI elements.
  - Apply a radius with GPS off: status line should show location missing message and list orders until GPS is allowed.
- Track tab
  - Track a test ARN or open a demo track; the track strip should be elevated, show name, address, km chips, and collapse/expand behavior unchanged.
- Claims list
  - Claim cards should show product photo (if provided), legs grid, earning column, and Claim/Skip buttons. Hovering a card gives a subtle elevation.
- Shop
  - Shop hero card avatar and action buttons appear correctly; product cards show rounded images, hover lift, and consistent padding.
- Home feed
  - Composer has a faint border and shadow; posts have subtle hover elevation and images display correctly.
- Messenger
  - Open Messages -> Inbox. Search box has border + shadow; rows highlight on hover.
  - Open a conversation. Chat bubbles have balanced padding; composer input is comfortable to tap.

How to commit these changes locally (optional)

Run these commands in the repo root (Windows PowerShell):

```powershell
git add portal.html ax-features.css ax-feed.css ax-social.css UI_POLISH_CHANGES.md
git commit -m "UI: polish Delivery/Track/Shop/Feed/Messenger styling"
git push
```

If you'd like, I can create a PR message template for you to paste into GitHub.

Next steps I can do for you:
- Create a PR branch and a tidy commit (I can provide the branch name and commands).
- Produce a short screenshot checklist with exact DOM selectors for QA automation.
- Further polish any specific component you point out.

Tell me which of the above you want me to do next.