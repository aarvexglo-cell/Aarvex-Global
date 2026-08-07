/* ── Search recommendations (Trade / Favourites / Home people) ─────────
   After the user types, show related product / shop / category suggestions
   under the active search field. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureBox(inputId, boxId) {
    var input = document.getElementById(inputId);
    if (!input) return null;
    var host = input.closest('.catalogue-search-unified')
      || input.closest('.catalogue-search-sticky')
      || input.closest('.ax-search-bar')
      || input.parentElement;
    if (!host) return null;
    var box = document.getElementById(boxId);
    if (!box) {
      box = document.createElement('div');
      box.id = boxId;
      box.className = 'ax-search-suggest';
      box.style.display = 'none';
      host.appendChild(box);
    }
    box.setAttribute('data-ax-ss-for', inputId);
    var posHost = host;
    if (getComputedStyle(posHost).position === 'static') {
      posHost.style.position = 'relative';
    }
    return box;
  }

  function hideBox(box) {
    if (!box) return;
    box.style.display = 'none';
    box.innerHTML = '';
  }

  function uniqueBy(arr, keyFn) {
    var seen = Object.create(null);
    var out = [];
    (arr || []).forEach(function (item) {
      var k = keyFn(item);
      if (!k || seen[k]) return;
      seen[k] = 1;
      out.push(item);
    });
    return out;
  }

  function isFavouritesContext(inputId) {
    if (inputId === 'favSearchInput') return true;
    var panel = document.getElementById('panel-favourites');
    return !!(panel && panel.classList.contains('active'));
  }

  function suggestionPool(forFav) {
    if (forFav) {
      if (typeof favouritesCatalogueAll !== 'undefined' && favouritesCatalogueAll && favouritesCatalogueAll.length) {
        return favouritesCatalogueAll;
      }
      if (typeof favouritesCatalogue !== 'undefined' && favouritesCatalogue) {
        return favouritesCatalogue;
      }
    }
    if (typeof filteredCatalogue !== 'undefined' && filteredCatalogue && filteredCatalogue.length) {
      return filteredCatalogue;
    }
    if (typeof catalogue !== 'undefined' && catalogue) return catalogue;
    return [];
  }

  function buildCatalogueSuggestions(q, forFav) {
    q = (q || '').trim().toLowerCase();
    if (q.length < 1) return { products: [], shops: [], categories: [] };
    var pool = suggestionPool(forFav);
    var products = [];
    var shops = [];
    var cats = [];
    var shopSeen = Object.create(null);
    var catSeen = Object.create(null);

    pool.forEach(function (p) {
      if (!p) return;
      var name = String(p.product_name || '');
      var shop = String(p.shop_name || '');
      var sid = String(p.shop_id || '');
      var cat = String(p.category_name || '');
      var blob = [name, shop, sid, cat, p.description || ''].join(' ').toLowerCase();
      if (blob.indexOf(q) < 0) return;
      if (name && products.length < 6) products.push(p);
      if ((shop || sid) && !shopSeen[sid || shop] && shops.length < 4) {
        shopSeen[sid || shop] = 1;
        shops.push({ shop_name: shop, shop_id: sid });
      }
      if (cat && !catSeen[cat] && cats.length < 4) {
        catSeen[cat] = 1;
        cats.push(cat);
      }
    });

    if (!forFav && typeof _axAllCategories !== 'undefined' && _axAllCategories) {
      (_axAllCategories || []).forEach(function (c) {
        var name = typeof c === 'string' ? c : (c && (c.name || c.category_name));
        if (!name) return;
        if (String(name).toLowerCase().indexOf(q) < 0) return;
        if (!catSeen[name] && cats.length < 5) {
          catSeen[name] = 1;
          cats.push(name);
        }
      });
    }

    return {
      products: uniqueBy(products, function (p) { return (p.shop_id || '') + '::' + (p.product_id || p.product_name); }),
      shops: shops,
      categories: cats
    };
  }

  function renderCatalogueSuggest(box, q, inputId) {
    var forFav = isFavouritesContext(inputId);
    var data = buildCatalogueSuggestions(q, forFav);
    var src = esc(inputId || (forFav ? 'favSearchInput' : 'catalogueSearchInput'));
    var html = '';
    if (data.categories.length) {
      html += '<div class="ax-search-suggest-label">Categories</div>';
      data.categories.forEach(function (cat, i) {
        html += '<button type="button" class="ax-search-suggest-row' + (i === 0 ? ' ax-ss-first' : '') + '" data-ax-ss="cat" data-ax-ss-input="' + src + '" data-val="' + esc(cat) + '">' +
          '<i class="fa-solid fa-tag"></i><span><b>' + esc(cat) + '</b><small>Browse category</small></span></button>';
      });
    }
    if (data.shops.length) {
      html += '<div class="ax-search-suggest-label">Shops</div>';
      data.shops.forEach(function (s) {
        var label = s.shop_name || s.shop_id || 'Shop';
        html += '<button type="button" class="ax-search-suggest-row" data-ax-ss="shop" data-ax-ss-input="' + src + '" data-val="' + esc(s.shop_id || s.shop_name) + '">' +
          '<i class="fa-solid fa-store"></i><span><b>' + esc(label) + '</b>' +
          (s.shop_id ? '<small>ID ' + esc(s.shop_id) + '</small>' : '') + '</span></button>';
      });
    }
    if (data.products.length) {
      html += '<div class="ax-search-suggest-label">Products</div>';
      data.products.forEach(function (p) {
        html += '<button type="button" class="ax-search-suggest-row" data-ax-ss="product" data-ax-ss-input="' + src + '" data-val="' + esc(p.product_name || '') + '" data-shop="' + esc(p.shop_id || '') + '">' +
          '<i class="fa-solid fa-box"></i><span><b>' + esc(p.product_name || 'Product') + '</b>' +
          '<small>' + esc(p.shop_name || p.category_name || '') + '</small></span></button>';
      });
    }
    if (!html) {
      box.innerHTML = '<div class="ax-search-suggest-empty">No matching recommendations</div>';
      box.style.display = '';
      return;
    }
    box.innerHTML = html;
    box.style.display = '';
  }

  function applySuggestion(kind, val, shopId, inputId) {
    var forFav = isFavouritesContext(inputId);
    var input = document.getElementById(forFav ? 'favSearchInput' : 'catalogueSearchInput');
    if (!input) return;
    input.value = val || '';

    if (forFav) {
      if (kind === 'cat' && typeof filterFavouritesGridByCategory === 'function') {
        filterFavouritesGridByCategory(val);
      } else if (typeof filterFavouritesGrid === 'function') {
        filterFavouritesGrid(val || '');
      }
      hideBox(document.getElementById('favSearchSuggest'));
      return;
    }

    if (kind === 'cat' && typeof filterCatalogueByCategoryName === 'function') {
      filterCatalogueByCategoryName(val);
    } else if (kind === 'shop') {
      if (typeof ProductModal !== 'undefined' && ProductModal.searchShop && ProductModal.searchShop(val)) {
        /* opened shop profile */
      } else if (typeof applyPortalCatalogueFilters === 'function') {
        applyPortalCatalogueFilters();
      }
    } else if (typeof applyPortalCatalogueFilters === 'function') {
      applyPortalCatalogueFilters();
    }
    hideBox(document.getElementById('catalogueSearchSuggest'));
  }

  var _timer = null;
  function onCatalogueInput(e) {
    var input = e.target;
    var id = input.id;
    var boxId = id === 'favSearchInput' ? 'favSearchSuggest' : 'catalogueSearchSuggest';
    var box = ensureBox(id, boxId);
    if (!box) return;
    var q = (input.value || '').trim();
    clearTimeout(_timer);
    if (q.length < 1) { hideBox(box); return; }
    _timer = setTimeout(function () { renderCatalogueSuggest(box, q, id); }, 160);
  }

  document.addEventListener('DOMContentLoaded', function () {
    ['catalogueSearchInput', 'favSearchInput'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', onCatalogueInput);
      el.addEventListener('focus', function () {
        if ((el.value || '').trim().length >= 1) onCatalogueInput({ target: el });
      });
    });

    document.addEventListener('click', function (e) {
      var row = e.target.closest && e.target.closest('.ax-search-suggest-row');
      if (row && row.getAttribute('data-ax-ss')) {
        e.preventDefault();
        var box = row.closest('.ax-search-suggest');
        var inputId = row.getAttribute('data-ax-ss-input')
          || (box && box.getAttribute('data-ax-ss-for'))
          || 'catalogueSearchInput';
        applySuggestion(
          row.getAttribute('data-ax-ss'),
          row.getAttribute('data-val'),
          row.getAttribute('data-shop'),
          inputId
        );
        return;
      }
      if (!e.target.closest('.catalogue-search-unified')
        && !e.target.closest('.catalogue-search-sticky')
        && !e.target.closest('.ax-search-suggest')) {
        hideBox(document.getElementById('catalogueSearchSuggest'));
        hideBox(document.getElementById('favSearchSuggest'));
      }
    });
  });

  window.axHideSearchSuggest = function () {
    hideBox(document.getElementById('catalogueSearchSuggest'));
    hideBox(document.getElementById('favSearchSuggest'));
  };
})();
