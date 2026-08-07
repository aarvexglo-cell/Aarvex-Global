/* Aarvex Portal — Navigation
 * Extracted from portal.html's inline <script> (was lines 1382-2900).
 * Panel switching, bottom-nav sync, search dock, auto-hide chrome, trade-mode tabs.
 * Depends on: portal-helpers.js (gv/sv/showToast) — load this AFTER portal-helpers.js.
 * NOTE: switchPanel() defined here is later overridden by portal-marketplace.js
 * (pre-existing behaviour, unchanged by this split — just flagging it).
 */

/* ── NAVIGATION ── */
function switchPanel(panelId) {
  if (panelId === 'order' || panelId === 'sell') {
    const mode = panelId;
    panelId = 'trade';
    document.querySelectorAll('.portal-panel').forEach(el => el.classList.remove('active'));
    const panel = document.getElementById('panel-' + panelId);
    if (panel) panel.classList.add('active');
    document.querySelectorAll('.sidebar-nav-item[data-panel]').forEach(el => el.classList.toggle('active', el.dataset.panel === panelId));
    document.querySelectorAll('.mobile-nav-btn').forEach(el => el.classList.toggle('active', el.dataset.panel === panelId));
    syncNavSlider();
    syncNavIcons();
    // Instant jump — smooth-scrolling from a deep scroll position took
    // hundreds of ms and made every tab switch feel sluggish on mobile.
    window.scrollTo(0, 0);
    switchTradeMode(mode);
    if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
    document.body.classList.toggle('ax-flush-top', panelId === 'dashboard' || panelId === 'trade');
    const navEl = document.querySelector('.nav');
    if (navEl) navEl.classList.toggle('on-trade-panel', panelId === 'trade');
    if (typeof window.searchDockUpdate === 'function') window.searchDockUpdate();
    if (typeof window.axChromeReset === 'function') window.axChromeReset();
    switchPanelClearAnimationFallback(panelId);
    try { document.dispatchEvent(new CustomEvent('ax:panel-changed', { detail: { panel: panelId } })); } catch (e) {}
    return;
  }
  document.querySelectorAll('.portal-panel').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('panel-' + panelId);
  if (panel) panel.classList.add('active');
  document.querySelectorAll('.sidebar-nav-item[data-panel]').forEach(el => el.classList.toggle('active', el.dataset.panel === panelId));
  document.querySelectorAll('.mobile-nav-btn').forEach(el => el.classList.toggle('active', el.dataset.panel === panelId));
  syncNavSlider();
  syncNavIcons();
  window.scrollTo(0, 0);
  if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
  document.body.classList.toggle('ax-flush-top', panelId === 'dashboard' || panelId === 'trade');
  const navEl = document.querySelector('.nav');
  if (navEl) navEl.classList.toggle('on-trade-panel', panelId === 'trade');
  if (panelId === 'trade') {
    const activeTradeTab = document.querySelector('.trade-mode-tab.active');
    if (!activeTradeTab) switchTradeMode('order');
    // Returning to Trade while Sell/Shop is still the active sub-mode:
    // flush-top only belongs to the Order catalogue (it has the ad).
    else document.body.classList.toggle('ax-flush-top', activeTradeTab.dataset.mode === 'order');
  }
  if (panelId === 'myorders') loadMyListings();
  if (panelId === 'favourites') renderFavouritesGrid();
  if (typeof window.searchDockUpdate === 'function') window.searchDockUpdate();
  if (typeof window.axChromeReset === 'function') window.axChromeReset();
  switchPanelClearAnimationFallback(panelId);
  try { document.dispatchEvent(new CustomEvent('ax:panel-changed', { detail: { panel: panelId } })); } catch (e) {}
}

/* Nav icon markup — inline SVG for Home, Font Awesome glyphs (already
   loaded for the whole page, zero extra network requests) for the rest.
   The old icons8 raster <img> icons hit img.icons8.com on every tab
   switch, which is what made the bottom nav feel laggy — and being
   raster, they could never be tinted brand-green via CSS. FA glyphs
   colour with `currentColor`, so active = solid green is pure CSS. */
/* Nav icons — the custom SVG set supplied by the product owner.
   LINE artwork = INACTIVE tab, FILL artwork = ACTIVE tab. Every colour is
   currentColor, so the active tab tints solid green straight from CSS. Inline
   SVG means they can never fail to load, and cost zero extra requests. */
function _navSvg(inner, vb) {
  return '<svg viewBox="' + (vb || '0 0 24 24') + '" width="24" height="24" fill="none" aria-hidden="true">' + inner + '</svg>';
}
const NAV_ICONS = {
  dashboard: {
    inactive: _navSvg('<path d="M2 12.2039C2 9.91549 2 8.77128 2.5192 7.82274C3.0384 6.87421 3.98695 6.28551 5.88403 5.10813L7.88403 3.86687C9.88939 2.62229 10.8921 2 12 2C13.1079 2 14.1106 2.62229 16.116 3.86687L18.116 5.10812C20.0131 6.28551 20.9616 6.87421 21.4808 7.82274C22 8.77128 22 9.91549 22 12.2039V13.725C22 17.6258 22 19.5763 20.8284 20.7881C19.6569 22 17.7712 22 14 22H10C6.22876 22 4.34315 22 3.17157 20.7881C2 19.5763 2 17.6258 2 13.725V12.2039Z" stroke="currentColor" stroke-width="1.5"/><path d="M15 18H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    active: _navSvg('<path fill-rule="evenodd" clip-rule="evenodd" d="M2.33537 7.87495C1.79491 9.00229 1.98463 10.3208 2.36407 12.9579L2.64284 14.8952C3.13025 18.2827 3.37396 19.9764 4.54903 20.9882C5.72409 22 7.44737 22 10.8939 22H13.1061C16.5526 22 18.2759 22 19.451 20.9882C20.626 19.9764 20.8697 18.2827 21.3572 14.8952L21.6359 12.9579C22.0154 10.3208 22.2051 9.00229 21.6646 7.87495C21.1242 6.7476 19.9738 6.06234 17.6731 4.69181L16.2882 3.86687C14.199 2.62229 13.1543 2 12 2C10.8457 2 9.80104 2.62229 7.71175 3.86687L6.32691 4.69181C4.02619 6.06234 2.87583 6.7476 2.33537 7.87495ZM8.2501 17.9998C8.2501 17.5856 8.58589 17.2498 9.0001 17.2498H15.0001C15.4143 17.2498 15.7501 17.5856 15.7501 17.9998C15.7501 18.414 15.4143 18.7498 15.0001 18.7498H9.0001C8.58589 18.7498 8.2501 18.414 8.2501 17.9998Z" fill="currentColor"/>')
  },
  trade: {
    inactive: _navSvg('<path d="M3.74157 18.5545C4.94119 20 7.17389 20 11.6393 20H12.3605C16.8259 20 19.0586 20 20.2582 18.5545M3.74157 18.5545C2.54194 17.1091 2.9534 14.9146 3.77633 10.5257C4.36155 7.40452 4.65416 5.84393 5.76506 4.92196M3.74157 18.5545C3.74156 18.5545 3.74157 18.5545 3.74157 18.5545ZM20.2582 18.5545C21.4578 17.1091 21.0464 14.9146 20.2235 10.5257C19.6382 7.40452 19.3456 5.84393 18.2347 4.92196M20.2582 18.5545C20.2582 18.5545 20.2582 18.5545 20.2582 18.5545ZM18.2347 4.92196C17.1238 4 15.5361 4 12.3605 4H11.6393C8.46374 4 6.87596 4 5.76506 4.92196M18.2347 4.92196C18.2347 4.92196 18.2347 4.92196 18.2347 4.92196ZM5.76506 4.92196C5.76506 4.92196 5.76506 4.92196 5.76506 4.92196Z" stroke="currentColor" stroke-width="1.5"/><path opacity="0.5" d="M9.1709 8C9.58273 9.16519 10.694 10 12.0002 10C13.3064 10 14.4177 9.16519 14.8295 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    active: _navSvg('<path fill-rule="evenodd" clip-rule="evenodd" d="M5.57386 4.69147C4.74068 5.38295 4.52122 6.55339 4.08231 8.89427L3.33231 12.8943C2.71512 16.186 2.40652 17.8318 3.30624 18.9159C4.20595 20 5.88048 20 9.22954 20H14.7704C18.1195 20 19.794 20 20.6937 18.9159C21.5934 17.8318 21.2849 16.186 20.6677 12.8943L19.9177 8.89427C19.4787 6.55339 19.2593 5.38295 18.4261 4.69147C17.5929 4 16.4021 4 14.0204 4H9.97954C7.59787 4 6.40703 4 5.57386 4.69147ZM9.87822 7.75007C10.1875 8.62497 11.0219 9.25 12.0004 9.25C12.9789 9.25 13.8133 8.62497 14.1225 7.75007C14.2606 7.35953 14.6891 7.15483 15.0796 7.29287C15.4701 7.43091 15.6748 7.8594 15.5368 8.24993C15.0224 9.70541 13.6343 10.75 12.0004 10.75C10.3664 10.75 8.97839 9.70541 8.46396 8.24993C8.32592 7.8594 8.53061 7.43091 8.92115 7.29287C9.31169 7.15483 9.74018 7.35953 9.87822 7.75007Z" fill="currentColor"/>')
  },
  favourites: {
    inactive: _navSvg('<path d="M12 6.5C10.4 4.1 7.4 3.2 5.3 4.9C3.4 6.4 2.9 9.1 4.1 11.1C5.2 13 7.9 15.1 9.9 16.6C11 17.5 11.5 17.85 12 17.85C12.5 17.85 13 17.5 14.1 16.6C16.1 15.1 18.8 13 19.9 11.1C21.1 9.1 20.6 6.4 18.7 4.9C16.6 3.2 13.6 4.1 12 6.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'),
    active: _navSvg('<path d="M2 9.1371C2 14 6.01943 16.5914 8.96173 18.9109C10 19.7294 11 20.5 12 20.5C13 20.5 14 19.7294 15.0383 18.9109C17.9806 16.5914 22 14 22 9.1371C22 4.27416 16.4998 0.825464 12 5.50063C7.50016 0.825464 2 4.27416 2 9.1371Z" fill="currentColor"/>')
  },
  shop: {
    inactive: _navSvg('<path fill-rule="evenodd" clip-rule="evenodd" d="M7.30681 1.24996C6.50585 1.24969 5.95624 1.24951 5.46776 1.38342C4.44215 1.66458 3.58414 2.36798 3.1073 3.31853C2.88019 3.77127 2.77258 4.31024 2.61576 5.0957L1.99616 8.19383C1.76456 9.35186 2.08191 10.4718 2.74977 11.3115L2.74977 14.0564C2.74975 15.8942 2.74974 17.3498 2.9029 18.489C3.06053 19.6614 3.39265 20.6104 4.14101 21.3587C4.88937 22.1071 5.83832 22.4392 7.01074 22.5969C8.14996 22.75 9.60559 22.75 11.4434 22.75H12.5562C14.3939 22.75 15.8496 22.75 16.9888 22.5969C18.1612 22.4392 19.1102 22.1071 19.8585 21.3587C20.6069 20.6104 20.939 19.6614 21.0966 18.489C21.2498 17.3498 21.2498 15.8942 21.2498 14.0564V11.3115C21.9176 10.4718 22.235 9.35187 22.0034 8.19383L21.3838 5.0957C21.227 4.31024 21.1194 3.77127 20.8923 3.31853C20.4154 2.36798 19.5574 1.66458 18.5318 1.38342C18.0433 1.24951 17.4937 1.24969 16.6927 1.24996H7.30681ZM18.2682 12.75C18.7971 12.75 19.2969 12.6435 19.7498 12.4524V14C19.7498 15.9068 19.7482 17.2615 19.61 18.2891C19.4747 19.2952 19.2211 19.8749 18.7979 20.2981C18.3747 20.7213 17.795 20.975 16.7889 21.1102C16.3434 21.1701 15.8365 21.2044 15.2498 21.2239V18.4678C15.2498 18.028 15.2498 17.6486 15.2216 17.3373C15.1917 17.0082 15.1257 16.6822 14.9483 16.375C14.7508 16.0329 14.4668 15.7489 14.1248 15.5514C13.8176 15.3741 13.4916 15.308 13.1624 15.2782C12.8511 15.25 12.4718 15.25 12.032 15.25H11.9675C11.5278 15.25 11.1484 15.25 10.8371 15.2782C10.5079 15.308 10.182 15.3741 9.87477 15.5514C9.53272 15.7489 9.24869 16.0329 9.05121 16.375C8.87384 16.6822 8.80778 17.0082 8.77795 17.3373C8.74973 17.6486 8.74975 18.028 8.74977 18.4678L8.74977 21.2239C8.16304 21.2044 7.6561 21.1701 7.21062 21.1102C6.20453 20.975 5.62488 20.7213 5.20167 20.2981C4.77846 19.8749 4.52479 19.2952 4.38953 18.2891C4.25136 17.2615 4.24977 15.9068 4.24977 14V12.4523C4.70264 12.6435 5.20244 12.75 5.73132 12.75C7.00523 12.75 8.14422 12.1216 8.83783 11.1458C9.54734 12.1139 10.6929 12.75 11.9996 12.75C13.3063 12.75 14.452 12.1138 15.1615 11.1455C15.8551 12.1215 16.9942 12.75 18.2682 12.75ZM10.2498 21.248C10.6382 21.2499 11.0539 21.25 11.4998 21.25H12.4998C12.9457 21.25 13.3614 21.2499 13.7498 21.248V18.5C13.7498 18.0189 13.749 17.7082 13.7277 17.4727C13.7073 17.2476 13.6729 17.1659 13.6493 17.125C13.5835 17.011 13.4888 16.9163 13.3748 16.8505C13.3339 16.8269 13.2522 16.7925 13.027 16.772C12.7916 16.7507 12.4809 16.75 11.9998 16.75C11.5187 16.75 11.208 16.7507 10.9725 16.772C10.7474 16.7925 10.6656 16.8269 10.6248 16.8505C10.5108 16.9163 10.4161 17.011 10.3502 17.125C10.3267 17.1659 10.2922 17.2476 10.2718 17.4727C10.2505 17.7082 10.2498 18.0189 10.2498 18.5V21.248ZM8.67082 2.74999H7.41748C6.46302 2.74999 6.13246 2.75654 5.86433 2.83005C5.24897 2.99874 4.73416 3.42078 4.44806 3.99112C4.3234 4.23962 4.25214 4.56248 4.06496 5.4984L3.46703 8.48801C3.18126 9.91687 4.27415 11.25 5.73132 11.25C6.91763 11.25 7.91094 10.3511 8.02898 9.17063L8.09757 8.48474L8.10155 8.44273L8.67082 2.74999ZM9.59103 8.62499L10.1785 2.74999H13.8208L14.405 8.59198C14.5473 10.0151 13.4298 11.25 11.9996 11.25C10.5804 11.25 9.46911 10.0341 9.59103 8.62499ZM18.1352 2.83005C17.8671 2.75654 17.5365 2.74999 16.5821 2.74999H15.3285L15.9706 9.17063C16.0886 10.3511 17.0819 11.25 18.2682 11.25C19.7254 11.25 20.8183 9.91687 20.5325 8.48801L19.9346 5.4984C19.7474 4.56248 19.6762 4.23962 19.5515 3.99112C19.2654 3.42078 18.7506 2.99874 18.1352 2.83005Z" fill="currentColor"/>'),
    active: _navSvg('<path d="M3.77791 3.65484C3.59687 4.01573 3.50783 4.46093 3.32975 5.35133L2.73183 8.34093C2.35324 10.2339 3.8011 12 5.73155 12C7.30318 12 8.61911 10.8091 8.77549 9.24527L8.8445 8.55515C8.68141 10.4038 10.1385 12 11.9998 12C13.8737 12 15.338 10.382 15.1515 8.51737L15.2245 9.24527C15.3809 10.8091 16.6968 12 18.2685 12C20.1989 12 21.6468 10.2339 21.2682 8.34093L20.6703 5.35133C20.4922 4.46095 20.4031 4.01573 20.2221 3.65484C19.8406 2.89439 19.1542 2.33168 18.3337 2.10675C17.9443 2 17.4903 2 16.5823 2H14.4998H7.41771C6.50969 2 6.05567 2 5.66628 2.10675C4.84579 2.33168 4.15938 2.89439 3.77791 3.65484Z" fill="currentColor"/><path d="M18.2685 13.5C19.0856 13.5 19.8448 13.2876 20.5 12.9189V14C20.5 17.7712 20.5 19.6568 19.3284 20.8284C18.3853 21.7715 16.9796 21.9554 14.5 21.9913V18.5C14.5 17.5654 14.5 17.0981 14.299 16.75C14.1674 16.522 13.978 16.3326 13.75 16.201C13.4019 16 12.9346 16 12 16C11.0654 16 10.5981 16 10.25 16.201C10.022 16.3326 9.83261 16.522 9.70096 16.75C9.5 17.0981 9.5 17.5654 9.5 18.5V21.9913C7.02043 21.9554 5.61466 21.7715 4.67157 20.8284C3.5 19.6568 3.5 17.7712 3.5 14V12.9189C4.15524 13.2876 4.91439 13.5 5.73157 13.5C6.92864 13.5 8.02617 13.0364 8.84435 12.2719C9.67168 13.0321 10.7765 13.5 11.9998 13.5C13.2232 13.5 14.3281 13.032 15.1555 12.2717C15.9737 13.0363 17.0713 13.5 18.2685 13.5Z" fill="currentColor"/>')
  },
  delivery: {
    inactive: _navSvg('<path d="M3 7C3 5.89543 3.89543 5 5 5H13C13.5523 5 14 5.44772 14 6V15.5H4C3.44772 15.5 3 15.0523 3 14.5V7Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 8.5H17.5L20.5 11.5V14.5C20.5 15.0523 20.0523 15.5 19.5 15.5H14V8.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="7" cy="17.5" r="2" stroke="currentColor" stroke-width="1.5"/><circle cx="17" cy="17.5" r="2" stroke="currentColor" stroke-width="1.5"/>'),
    active: _navSvg('<path d="M3 7C3 5.89543 3.89543 5 5 5H13C13.5523 5 14 5.44772 14 6V15.25H3V7Z" fill="currentColor"/><path d="M14 8.5H17.5L20.75 11.75V15.25H14V8.5Z" fill="currentColor"/><circle cx="7" cy="17.6" r="2.1" fill="currentColor"/><circle cx="17" cy="17.6" r="2.1" fill="currentColor"/>')
  },
  profile: {
    inactive: _navSvg('<path d="M12 11C14.4853 11 16.5 8.98528 16.5 6.5C16.5 4.01472 14.4853 2 12 2C9.51472 2 7.5 4.01472 7.5 6.5C7.5 8.98528 9.51472 11 12 11Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 18.5714C5 16.0467 7.0467 14 9.57143 14H14.4286C16.9533 14 19 16.0467 19 18.5714C19 20.465 17.465 22 15.5714 22H8.42857C6.53502 22 5 20.465 5 18.5714Z" stroke="currentColor" stroke-width="1.5"/>'),
    active: _navSvg('<path fill-rule="evenodd" clip-rule="evenodd" d="M6.75 6.5C6.75 3.6005 9.1005 1.25 12 1.25C14.8995 1.25 17.25 3.6005 17.25 6.5C17.25 9.3995 14.8995 11.75 12 11.75C9.1005 11.75 6.75 9.3995 6.75 6.5Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M4.25 18.5714C4.25 15.6325 6.63249 13.25 9.57143 13.25H14.4286C17.3675 13.25 19.75 15.6325 19.75 18.5714C19.75 20.8792 17.8792 22.75 15.5714 22.75H8.42857C6.12081 22.75 4.25 20.8792 4.25 18.5714Z" fill="currentColor"/>')
  },
  track: {
    inactive: _navSvg('<circle cx="12" cy="12" r="7.25" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M12 2.5V5.25M12 18.75V21.5M2.5 12H5.25M18.75 12H21.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    active: _navSvg('<path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M12 3C12.5523 3 13 3.44772 13 4V5.07089C16.0657 5.5094 18.4906 7.93431 18.9291 11H20C20.5523 11 21 11.4477 21 12C21 12.5523 20.5523 13 20 13H18.9291C18.4906 16.0657 16.0657 18.4906 13 18.9291V20C13 20.5523 12.5523 21 12 21C11.4477 21 11 20.5523 11 20V18.9291C7.93431 18.4906 5.5094 16.0657 5.07089 13H4C3.44772 13 3 12.5523 3 12C3 11.4477 3.44772 11 4 11H5.07089C5.5094 7.93431 7.93431 5.5094 11 5.07089V4C11 3.44772 11.4477 3 12 3ZM7 12C7 9.23858 9.23858 7 12 7C14.7614 7 17 9.23858 17 12C17 14.7614 14.7614 17 12 17C9.23858 17 7 14.7614 7 12Z" fill="currentColor"/>')
  },
  myorders: {
    inactive: _navSvg('<path d="M15.5777 3.38197L17.5777 4.43152C19.7294 5.56066 20.8052 6.12523 21.4026 7.13974C22 8.15425 22 9.41667 22 11.9415V12.0585C22 14.5833 22 15.8458 21.4026 16.8603C20.8052 17.8748 19.7294 18.4393 17.5777 19.5685L15.5777 20.618C13.8221 21.5393 12.9443 22 12 22C11.0557 22 10.1779 21.5393 8.42229 20.618L6.42229 19.5685C4.27063 18.4393 3.19479 17.8748 2.5974 16.8603C2 15.8458 2 14.5833 2 12.0585V11.9415C2 9.41667 2 8.15425 2.5974 7.13974C3.19479 6.12523 4.27063 5.56066 6.42229 4.43152L8.42229 3.38197C10.1779 2.46066 11.0557 2 12 2C12.9443 2 13.8221 2.46066 15.5777 3.38197Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M21 7.5L12 12M12 12L3 7.5M12 12V21.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    active: _navSvg('<path d="M17.5777 4.43152L15.5777 3.38197C13.8221 2.46066 12.9443 2 12 2C11.0557 2 10.1779 2.46066 8.42229 3.38197L6.42229 4.43152C4.64855 5.36234 3.6059 5.9095 2.95969 6.64132L12 11.1615L21.0403 6.64132C20.3941 5.9095 19.3515 5.36234 17.5777 4.43152Z" fill="currentColor"/><path d="M21.7484 7.96435L12.75 12.4635V21.904C13.4679 21.7252 14.2848 21.2965 15.5777 20.618L17.5777 19.5685C19.7294 18.4393 20.8052 17.8748 21.4026 16.8603C22 15.8458 22 14.5833 22 12.0585V11.9415C22 10.0489 22 8.86558 21.7484 7.96435Z" fill="currentColor"/><path d="M11.25 21.904V12.4635L2.25164 7.96434C2 8.86557 2 10.0489 2 11.9415V12.0585C2 14.5833 2 15.8458 2.5974 16.8603C3.19479 17.8748 4.27063 18.4393 6.42229 19.5685L8.42229 20.618C9.71524 21.2965 10.5321 21.7252 11.25 21.904Z" fill="currentColor"/>')
  },
  account: {
    inactive: _navSvg('<path d="M3 10C3 6.22876 3 4.34315 4.17157 3.17157C5.34315 2 7.22876 2 11 2H13C16.7712 2 18.6569 2 19.8284 3.17157C21 4.34315 21 6.22876 21 10V14C21 17.7712 21 19.6569 19.8284 20.8284C18.6569 22 16.7712 22 13 22H11C7.22876 22 5.34315 22 4.17157 20.8284C3 19.6569 3 17.7712 3 14V10Z" stroke="currentColor" stroke-width="1.5"/><path d="M8 10H16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8 14H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    active: _navSvg('<path fill-rule="evenodd" clip-rule="evenodd" d="M4.17157 3.17157C3 4.34315 3 6.22876 3 10V14C3 17.7712 3 19.6569 4.17157 20.8284C5.34315 22 7.22876 22 11 22H13C16.7712 22 18.6569 22 19.8284 20.8284C21 19.6569 21 17.7712 21 14V10C21 6.22876 21 4.34315 19.8284 3.17157C18.6569 2 16.7712 2 13 2H11C7.22876 2 5.34315 2 4.17157 3.17157ZM8 9.25C7.58579 9.25 7.25 9.58579 7.25 10C7.25 10.4142 7.58579 10.75 8 10.75H16C16.4142 10.75 16.75 10.4142 16.75 10C16.75 9.58579 16.4142 9.25 16 9.25H8ZM8 13.25C7.58579 13.25 7.25 13.5858 7.25 14C7.25 14.4142 7.58579 14.75 8 14.75H13C13.4142 14.75 13.75 14.4142 13.75 14C13.75 13.5858 13.4142 13.25 13 13.25H8Z" fill="currentColor"/>')
  },
  referral: {
    inactive: _navSvg('<path d="M4 9C4 8.44772 4.44772 8 5 8H19C19.5523 8 20 8.44772 20 9V11C20 11.5523 19.5523 12 19 12H5C4.44772 12 4 11.5523 4 11V9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M5.5 12V19C5.5 19.5523 5.94772 20 6.5 20H17.5C18.0523 20 18.5 19.5523 18.5 19V12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 8V20" stroke="currentColor" stroke-width="1.5"/><path d="M12 8C12 8 11.25 4.5 8.75 4.5C7.64543 4.5 6.75 5.17157 6.75 6.25C6.75 7.32843 7.64543 8 8.75 8H12Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 8C12 8 12.75 4.5 15.25 4.5C16.3546 4.5 17.25 5.17157 17.25 6.25C17.25 7.32843 16.3546 8 15.25 8H12Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'),
    active: _navSvg('<path d="M4 9C4 8.44772 4.44772 8 5 8H11.25V12H5C4.44772 12 4 11.5523 4 11V9Z" fill="currentColor"/><path d="M12.75 8H19C19.5523 8 20 8.44772 20 9V11C20 11.5523 19.5523 12 19 12H12.75V8Z" fill="currentColor"/><path d="M5.5 13.5H11.25V20H6.5C5.94772 20 5.5 19.5523 5.5 19V13.5Z" fill="currentColor"/><path d="M12.75 13.5H18.5V19C18.5 19.5523 18.0523 20 17.5 20H12.75V13.5Z" fill="currentColor"/><path d="M11.4 6.6C11.1 5.4 10.2 4.5 8.75 4.5C7.64543 4.5 6.75 5.17157 6.75 6.25C6.75 7.32843 7.64543 8 8.75 8H11.5L11.4 6.6Z" fill="currentColor"/><path d="M12.6 6.6C12.9 5.4 13.8 4.5 15.25 4.5C16.3546 4.5 17.25 5.17157 17.25 6.25C17.25 7.32843 16.3546 8 15.25 8H12.5L12.6 6.6Z" fill="currentColor"/>')
  },
  rfq: {
    inactive: _navSvg('<path d="M6 4.5H18C19.3807 4.5 20.5 5.61929 20.5 7V13C20.5 14.3807 19.3807 15.5 18 15.5H11L6.5 19V15.5H6C4.61929 15.5 3.5 14.3807 3.5 13V7C3.5 5.61929 4.61929 4.5 6 4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8.5" cy="10" r="1" fill="currentColor"/><circle cx="12" cy="10" r="1" fill="currentColor"/><circle cx="15.5" cy="10" r="1" fill="currentColor"/>'),
    active: _navSvg('<path d="M6 4.5H18C19.3807 4.5 20.5 5.61929 20.5 7V13C20.5 14.3807 19.3807 15.5 18 15.5H11L6.5 19V15.5H6C4.61929 15.5 3.5 14.3807 3.5 13V7C3.5 5.61929 4.61929 4.5 6 4.5Z" fill="currentColor"/>')
  },
  /* Sell (produce) — sprout. Non-panel action, but keyed here so the drawer
     grid can render a matching line/solid glyph via a data-icon-key hook. */
  sell: {
    inactive: _navSvg('<path d="M12 21V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 12C9 12 6.5 9.5 6.5 6.5C6.5 5.94772 6.94772 5.5 7.5 5.5C10.5 5.5 12 8 12 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 10C12 7 13.8 4 17 4C17.5523 4 18 4.44772 18 5C18 8 15.5 10.5 12.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
    active: _navSvg('<path d="M12 21V11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 12.5C8.68629 12.5 6 9.81371 6 6.5C6 5.94772 6.44772 5.5 7 5.5C10.3137 5.5 13 8.18629 13 11.5V12.5H12Z" fill="currentColor"/><path d="M12 11.5C12 8.18629 14.6863 5.5 18 5.5C18.5523 5.5 19 5.94772 19 6.5C19 9.81371 16.3137 12.5 13 12.5H12V11.5Z" fill="currentColor"/>')
  },
  website: {
    inactive: _navSvg('<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M3 12H21" stroke="currentColor" stroke-width="1.5"/><path d="M12 3C14.5 5.5 15.75 8.75 15.75 12C15.75 15.25 14.5 18.5 12 21C9.5 18.5 8.25 15.25 8.25 12C8.25 8.75 9.5 5.5 12 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'),
    active: _navSvg('<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M3 12H21" stroke="currentColor" stroke-width="1.5"/><path d="M12 3C14.5 5.5 15.75 8.75 15.75 12C15.75 15.25 14.5 18.5 12 21C9.5 18.5 8.25 15.25 8.25 12C8.25 8.75 9.5 5.5 12 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>')
  }
};

/* Swaps each nav icon's innerHTML between its inactive/active markup
   from NAV_ICONS (keyed by data-icon-key), and re-triggers the .pop
   bounce animation whenever a button just became active. Called every
   time switchPanel() updates .active. */
function syncNavIcons() {
  /* One rule everywhere (sidebar drawer + bottom nav, desktop + mobile):
     LINE glyph by default, SOLID glyph only for the selected tab. Non-panel
     utility icons (Sell, Website) have no [data-panel] ancestor, so they
     always render their line glyph. This replaces the old "mobile drawer =
     always solid" behaviour the owner asked to remove. */
  document.querySelectorAll('.nav-anim-icon[data-icon-key]')
    .forEach(icon => {
      const key = icon.dataset.iconKey;
      const iconData = NAV_ICONS[key];
      if (!iconData) return;
      const btn = icon.closest('[data-panel]');
      const isActive = !!(btn && btn.classList.contains('active'));
      const wasActive = icon.classList.contains('is-active-icon');
      icon.innerHTML = isActive ? iconData.active : iconData.inactive;
      icon.classList.toggle('is-active-icon', isActive);
      if (isActive && !wasActive) {
        icon.classList.add('pop');
        icon.addEventListener('animationend', () => icon.classList.remove('pop'), { once: true });
      }
    });
}
document.addEventListener('DOMContentLoaded', syncNavIcons);
/* Dashboard is the default active panel on load and never goes through
   switchPanel(), so seed the flush-top class here (CSS additionally gates
   it behind body.is-signed-in so the login screen is unaffected). */
document.addEventListener('DOMContentLoaded', () => {
  const active = document.querySelector('.portal-panel.active');
  const id = active ? active.id.replace('panel-', '') : 'dashboard';
  document.body.classList.toggle('ax-flush-top', id === 'dashboard' || id === 'trade');
});

/* Positions the shared sliding highlight pills behind whichever sidebar /
   mobile nav button is currently active, animating between buttons via
   CSS transitions (see .sidebar-nav-slider / .mobile-nav-slider). */
function syncNavSlider() {
  const sideSlider = document.getElementById('sidebarNavSlider');
  const activeSideItem = document.querySelector('.sidebar-nav-item[data-panel].active');
  if (sideSlider && activeSideItem) {
    sideSlider.style.transform = 'translateY(' + activeSideItem.offsetTop + 'px)';
    sideSlider.style.height = activeSideItem.offsetHeight + 'px';
    sideSlider.classList.add('ready');
  }
  const mobSlider = document.getElementById('mobileNavSlider');
  const activeMobBtn = document.querySelector('.mobile-nav-btn[data-panel].active');
  if (mobSlider && activeMobBtn) {
    mobSlider.style.transform = 'translateX(' + activeMobBtn.offsetLeft + 'px)';
    mobSlider.style.width = activeMobBtn.offsetWidth + 'px';
    mobSlider.classList.add('ready');
  }
}
window.addEventListener('resize', () => { if (typeof syncNavSlider === 'function') syncNavSlider(); });
document.addEventListener('DOMContentLoaded', () => { setTimeout(() => { if (typeof syncNavSlider === 'function') syncNavSlider(); }, 50); });

/* Docks the trade-tab search bar under the header once it scrolls past the
   ad banner. Unlike the old two-layer version (nav icons faded but the
   search bar stayed in its own sticky slot below the now-transparent nav,
   which read as a header split in two), this makes `.catalogue-search-sticky`
   go `position:fixed` and take over the nav's exact box (top:0, full width,
   nav's height, higher z-index) once docked — it visually *becomes* the
   header instead of sitting under it.
   `.search-docked` on <nav> still drives the hamburger/profile/notification
   fade (opacity+transform, so the change stays a smooth CSS transition);
   once that fade finishes we additionally set display:none on those
   elements via JS (transitionend) so their layout space collapses too —
   otherwise the flex gap between them would leave a dead gap even at
   opacity:0. Undocking reverses the exact same sequence: layout space is
   restored first (still invisible, since the docked classes are still on),
   then the classes are removed on the next frame so the fade-in animates
   over real, already-spaced-out elements instead of popping in. */
function initSearchDock() {
  const nav = document.querySelector('.nav');
  // Generalized to every `.catalogue-search-sticky` in the page (Trade →
  // Order catalogue, Trade → Shop Directory, and any future panel that
  // reuses this wrapper) instead of hard-coding to a single instance/panel —
  // this is what makes the scroll-collapse header work on every tab that
  // has a search bar, not just the Order catalogue.
  const searchBars = Array.from(document.querySelectorAll('.catalogue-search-sticky'));
  if (!nav || !searchBars.length) return;
  const collapseEls = [
    document.querySelector('.nav-profile-wrap'),
    ...document.querySelectorAll('.nav-right .nav-btn'),
  ].filter(Boolean);

  // A same-height placeholder inserted right after each bar so switching
  // that bar to position:fixed doesn't yank the content below it upward.
  searchBars.forEach(bar => {
    const spacer = document.createElement('div');
    spacer.className = 'search-dock-spacer';
    bar.insertAdjacentElement('afterend', spacer);
    bar._dockSpacer = spacer;
  });

  function collapseNavIcons() {
    collapseEls.forEach(el => { el.style.display = 'none'; });
  }
  function restoreNavIcons() {
    collapseEls.forEach(el => { el.style.display = ''; });
  }
  collapseEls.forEach(el => el.addEventListener('transitionend', (e) => {
    // Only collapse once the fade itself is done, and only if we're still
    // meant to be docked (guards against a stale event firing after a
    // quick scroll-back-up already restored things).
    if (e.propertyName === 'opacity' && nav.classList.contains('search-docked')) collapseNavIcons();
  }));

  let dockedBar = null;
  function dock(bar) {
    if (dockedBar === bar) return;
    if (dockedBar) undock(dockedBar);
    dockedBar = bar;
    // Before is-docked: flush-top Trade may include padding-top (~54px) for the
    // floating header. That padding drops on dock — subtract it from the spacer
    // in the SAME turn so content doesn't (a) jump twice or (b) leave a hollow
    // band under the fixed chrome. Never reserve less than the chrome height.
    const padTop = parseFloat(getComputedStyle(bar).paddingTop) || 0;
    const flowH = bar.offsetHeight || 0;
    const minDock = window.matchMedia('(max-width:768px)').matches ? 58 : 64;
    bar._dockSpacer.style.height = Math.max(minDock, flowH - padTop) + 'px';
    bar._dockSpacer.classList.add('active');
    nav.classList.add('search-docked');
    bar.classList.add('is-docked');
  }
  function undock(bar) {
    if (dockedBar !== bar) return;
    dockedBar = null;
    restoreNavIcons();
    bar._dockSpacer.classList.remove('active');
    bar._dockSpacer.style.height = '';
    // Synchronous — the old requestAnimationFrame deferral could lose the
    // race against a panel switch, leaving a stuck is-docked bar floating
    // over the next panel with the real header icons frozen at opacity 0
    // (the "double hamburger / buttons dabte hain" bug).
    nav.classList.remove('search-docked');
    bar.classList.remove('is-docked');
  }

  let ticking = false;
  function update() {
    ticking = false;
    // Whichever search bar is actually on screen right now. NOTE: a DOCKED
    // bar is position:fixed, and fixed elements report offsetParent === null
    // even while fully visible — so the panel's .active class is the source
    // of truth, and the currently-docked bar is matched explicitly. The old
    // offsetParent-only check misclassified the docked bar as hidden, which
    // is what let dock state leak across panel switches.
    const visibleBar = searchBars.find(b => {
      const panel = b.closest('.portal-panel');
      if (panel && !panel.classList.contains('active')) return false;
      if (b === dockedBar) return true;
      return b.offsetParent !== null;
    });
    if (!visibleBar) { if (dockedBar) undock(dockedBar); return; }
    const navH = nav.offsetHeight || 64;
    const rect = visibleBar.getBoundingClientRect();
    // When docked the bar is position:fixed, so its own rect.top is pinned to
    // the header and can't tell us when to undock. The spacer sits in the bar's
    // original flow slot, so spacer.top IS where the bar would naturally be —
    // use it directly. (Previously this subtracted the spacer height, which
    // added a full bar-height of hysteresis: scrolling back to the top left the
    // bar stuck at the header instead of dropping back under the ad.)
    const referenceTop = dockedBar === visibleBar ? visibleBar._dockSpacer.getBoundingClientRect().top : rect.top;
    if (referenceTop <= navH + 1) dock(visibleBar); else undock(visibleBar);
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  window.searchDockUpdate = update;
  update();
}
document.addEventListener('DOMContentLoaded', initSearchDock);

/* ══════════════════════════════════════════════════════════════
   HEADER + BOTTOM-NAV AUTO-HIDE ON SCROLL (Prompt 4.txt Task F)
   Mobile-only (desktop keeps a persistent sidebar + header — hiding just
   the top bar there would look broken). Scrolling further into a page's
   content slides both the header and bottom-nav out of view for a
   full-screen reading area; scrolling back toward the top (or within
   TOP_BUFFER of it) brings them back. Also hides Trade's docked search
   bar when it's standing in for the header (see initSearchDock() above)
   so the two systems never leave a half-hidden header on screen. */
function initAutoHideChrome() {
  const nav = document.querySelector('.nav');
  const footer = document.getElementById('mobileNav');
  if (!nav || !footer) return;
  let lastY = window.scrollY;
  let hidden = false, ticking = false;
  // Hysteresis accumulator — the old version flipped on ANY 8px direction
  // change, so natural finger jitter / scroll-momentum wobble made the
  // header, footer and search bar rapid-fire in and out ("flicker").
  // Now the scroll has to travel a real distance in ONE direction before
  // anything toggles: a deliberate down-scroll hides, a small up-scroll
  // shows (shows stay eager so reaching for the header feels instant,
  // hides are lazy so browsing never trembles).
  let travel = 0, travelDir = 0;
  const TOP_BUFFER = 90, HIDE_TRAVEL = 64, SHOW_TRAVEL = 14;

  function apply(shouldHide) {
    if (shouldHide === hidden) return;
    hidden = shouldHide;
    // ONE class on <body> drives every piece of chrome via CSS (see
    // portal-ui.css) — the old per-element toggling left newly-docked
    // search bars out of sync with the nav/footer, which is where the
    // "search bar stuck floating mid-screen" states came from.
    document.body.classList.toggle('ax-chrome-hidden', hidden);
  }
  function update() {
    ticking = false;
    if (window.innerWidth > 768) { apply(false); return; }
    const maxY = Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight);
    // Clamp: rubber-band overscroll at the top/bottom reports out-of-range
    // scrollY values whose rebound reads as a fake direction change.
    const y = Math.max(0, Math.min(window.scrollY, maxY));
    const dy = y - lastY;
    lastY = y;
    if (y < TOP_BUFFER) { travel = 0; travelDir = 0; apply(false); return; }
    if (!dy) return;
    const dir = dy > 0 ? 1 : -1;
    if (dir !== travelDir) { travel = 0; travelDir = dir; }
    travel += Math.abs(dy);
    if (dir === 1 && travel >= HIDE_TRAVEL) apply(true);
    else if (dir === -1 && travel >= SHOW_TRAVEL) apply(false);
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener('resize', update);
  window.axChromeReset = () => { travel = 0; travelDir = 0; lastY = window.scrollY; apply(false); };
}
document.addEventListener('DOMContentLoaded', initAutoHideChrome);

/* .portal-panel.active plays a one-off fade/slide-in (@keyframes panelIn,
   fill-mode:both) on every switchPanel() call. Because the animation's
   `to` keyframe is `transform:none`, the browser keeps reporting a
   resolved identity matrix (not the literal keyword "none") for as long
   as that filled animation stays attached — and per spec, ANY non-"none"
   transform on an ancestor makes it the containing block for
   `position:fixed` descendants instead of the viewport. That silently
   broke the Trade tab's docked search bar (and would break the new
   header/footer auto-hide transforms too): once docked, it was
   positioning itself relative to the scrolling panel instead of staying
   pinned to the screen. Clearing the animation once it finishes restores
   a true `transform:none` so position:fixed descendants dock to the
   viewport again. */
function clearPanelInAnimation(panel) {
  if (panel) panel.style.animation = 'none';
}
document.addEventListener('animationend', function (e) {
  if (e.animationName === 'panelIn' && e.target.classList.contains('portal-panel')) {
    clearPanelInAnimation(e.target);
  }
});
/* Fallback in case animationend never fires (backgrounded tab, reduced-
   motion, or any other reason the browser skips/interrupts the CSS
   animation) — the panelIn animation is 0.3s, so 400ms is a safe margin. */
function switchPanelClearAnimationFallback(panelId) {
  setTimeout(() => clearPanelInAnimation(document.getElementById('panel-' + panelId)), 400);
}
function switchTradeMode(mode) {
  document.querySelectorAll('.trade-mode-tab').forEach(el => el.classList.toggle('active', el.dataset.mode === mode));
  // Flush-top (ad at the very top, floating header icons) only makes
  // sense on the Order catalogue — Sell / Shop Directory start with
  // regular content and need the normal header offset back.
  if (document.getElementById('panel-trade')?.classList.contains('active')) {
    document.body.classList.toggle('ax-flush-top', mode === 'order');
  }
  document.getElementById('tradeOrderSection').style.display = mode === 'order' ? '' : 'none';
  document.getElementById('tradeSellSection').style.display = mode === 'sell' ? '' : 'none';
  document.getElementById('shopDirectoryStep').style.display = mode === 'shop' ? '' : 'none';
  if (mode === 'order') {
    if (!selectedProduct) {
      document.getElementById('orderStep1').style.display = '';
      document.getElementById('orderStep2').style.display = 'none';
      setOrderProgressStep(1);
    }
    prefillForms();
  }
  if (mode === 'sell') prefillForms();
  if (mode === 'shop') loadShopDirectory();
  // The search-dock behaviour only targets the Order sub-view's sticky
  // search bar — switching away from it should immediately release any
  // docked state instead of waiting for the next scroll event.
  if (typeof window.searchDockUpdate === 'function') window.searchDockUpdate();
}
