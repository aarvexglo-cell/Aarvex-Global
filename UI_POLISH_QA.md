UI Polish QA Checklist

- [ ] Delivery radius: verify presets (5/10/20/50 km) set input and refresh claims
- [ ] "Use my location" button saves GPS to window._axPartnerPos and refreshes claims
- [ ] Claims list: no over-filtering — partner→shop server side, triangle client check
- [ ] Chat: draft persistence (type, attach) preserved in localStorage per conversation
- [ ] Chat: attachment preview shows image or document and has clear remove button
- [ ] Chat: unread badge updates (header) after receiving messages
- [ ] Accessibility: icon-only buttons have aria-labels; focus-visible outlines present
- [ ] Dark mode: cards and chat bubbles render without glaring white patches
- [ ] Touch: map controls and icon buttons are >=44px
- [ ] Performance: heavy shadows reduced across cards

Git commands to create a branch and push changes:

```powershell
git checkout -b ui/polish-delivery-track-messenger
git add portal.html ax-delivery-ux.js ax-features.css ax-feed.css ax-social.css portal-enhancements.js UI_POLISH_CHANGES.md UI_POLISH_QA.md
git commit -m "UI: polish delivery/track/shop/feed/messenger; add radius presets + accessibility improvements"
git push -u origin ui/polish-delivery-track-messenger
```

Suggested PR description:

Title: UI polish: delivery radius UX, messenger improvements, dark-mode parity

Summary:
- Added delivery radius presets and "Use my location" helper
- Improved visual consistency: card radii, shadows, CTAs
- Accessibility: focus-visible outlines, aria labels for icon buttons
- Messenger: drafts persist to localStorage, attachment preview styling
- Dark-mode parity fixes for cards and chat bubbles

Testing notes:
- Visual sanity check on desktop and mobile viewport (<= 390px)
- Verify chat compose/send flow and draft persistence
- Confirm no console errors on load

If you want, I can run the git commands and prepare a PR draft locally.```