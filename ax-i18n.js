/* Aarvex Portal — i18n + full-page live translator
 * 1) Dictionary keys (data-i18n / t()) — instant, curated
 * 2) Free live API — scans the whole visible DOM and translates
 *    remaining English text to Hindi / Marathi (and back to EN)
 *
 * APIs (no key required):
 *   Primary: Google Translate free endpoint (client=gtx)
 *   Fallback: MyMemory Translation API
 */
'use strict';

const AX_LANGS = { en: 'English', hi: 'हिंदी', mr: 'मराठी' };

const AX_I18N = {
  'nav.home': { hi: 'होम', mr: 'होम' },
  'nav.trade': { hi: 'ट्रेड', mr: 'ट्रेड' },
  'nav.favourites': { hi: 'पसंदीदा', mr: 'आवडते' },
  'nav.shop': { hi: 'दुकान', mr: 'दुकान' },
  'nav.delivery': { hi: 'डिलीवरी', mr: 'डिलिव्हरी' },
  'nav.dashboard': { hi: 'डैशबोर्ड', mr: 'डॅशबोर्ड' },
  'nav.tradeHub': { hi: 'ट्रेड हब', mr: 'ट्रेड हब' },
  'nav.myShop': { hi: 'मेरी दुकान', mr: 'माझं दुकान' },
  'nav.sellProduce': { hi: 'फसल बेचें', mr: 'पीक विका' },
  'nav.myProfile': { hi: 'मेरी प्रोफाइल', mr: 'माझी प्रोफाइल' },
  'nav.myProducts': { hi: 'मेरे प्रोडक्ट', mr: 'माझे प्रॉडक्ट' },
  'nav.trackOrder': { hi: 'ऑर्डर ट्रैक करें', mr: 'ऑर्डर ट्रॅक करा' },
  'nav.account': { hi: 'अकाउंट और हिस्ट्री', mr: 'खातं व इतिहास' },
  'nav.negotiations': { hi: 'मोल-भाव', mr: 'घासाघीस' },
  'nav.refer': { hi: 'रेफर करें और कमाएं', mr: 'रेफर करा व कमवा' },
  'common.products': { hi: 'प्रोडक्ट', mr: 'प्रॉडक्ट' },
  'common.shops': { hi: 'दुकानें', mr: 'दुकाने' },
  'common.buyNow': { hi: 'अभी खरीदें', mr: 'आता खरेदी करा' },
  'common.buy': { hi: 'खरीदें', mr: 'खरेदी करा' },
  'common.negotiate': { hi: 'मोल-भाव करें', mr: 'घासाघीस करा' },
  'common.addProduct': { hi: 'प्रोडक्ट जोड़ें', mr: 'प्रॉडक्ट जोडा' },
  'common.editShop': { hi: 'दुकान एडिट करें', mr: 'दुकान संपादित करा' },
  'common.search': { hi: 'खोजें', mr: 'शोधा' },
  'common.seeAll': { hi: 'सभी देखें', mr: 'सर्व पहा' },
  'common.loadMore': { hi: 'और देखें', mr: 'अधिक पहा' },
  'common.viewAll': { hi: 'सभी देखें', mr: 'सर्व पहा' },
  'common.submit': { hi: 'सबमिट करें', mr: 'सबमिट करा' },
  'common.cancel': { hi: 'रद्द करें', mr: 'रद्द करा' },
  'common.save': { hi: 'सेव करें', mr: 'जतन करा' },
  'common.delete': { hi: 'डिलीट करें', mr: 'हटवा' },
  'common.track': { hi: 'ट्रैक करें', mr: 'ट्रॅक करा' },
  'common.invoice': { hi: 'इनवॉइस', mr: 'बिल' },
  'common.rateDelivery': { hi: 'डिलीवरी को रेट करें', mr: 'डिलिव्हरी रेट करा' },
  'common.reportProblem': { hi: 'समस्या बताएं', mr: 'तक्रार नोंदवा' },
  'common.loading': { hi: 'लोड हो रहा है…', mr: 'लोड होत आहे…' },
  'common.inStock': { hi: 'स्टॉक में', mr: 'स्टॉकमध्ये' },
  'common.perKg': { hi: 'प्रति किलो', mr: 'प्रति किलो' },
  'trade.bestOffers': { hi: 'बेस्ट ऑफर', mr: 'सर्वोत्तम ऑफर' },
  'trade.topShops': { hi: 'टॉप दुकानें', mr: 'टॉप दुकाने' },
  'trade.topRated': { hi: 'टॉप रेटेड', mr: 'टॉप रेटेड' },
  'trade.limitedTime': { hi: 'सीमित समय', mr: 'मर्यादित वेळ' },
  'trade.starShops': { hi: 'स्टार परफॉर्मर दुकानें', mr: 'स्टार परफॉर्मर दुकाने' },
  'trade.priceAlert': { hi: 'प्राइस अलर्ट सेट करें', mr: 'किंमत अलर्ट सेट करा' },
  'page.myFavourites': { hi: 'मेरे पसंदीदा', mr: 'माझे आवडते' },
  'page.accountHistory': { hi: 'अकाउंट और हिस्ट्री', mr: 'खातं व इतिहास' },
  'page.browseAllShops': { hi: 'सभी दुकानें देखें', mr: 'सर्व दुकाने पहा' },
  'page.orderDetails': { hi: 'ऑर्डर की जानकारी', mr: 'ऑर्डर तपशील' },
  'page.settings': { hi: 'सेटिंग्स', mr: 'सेटिंग्ज' },
  'order.sample': { hi: 'सैंपल', mr: 'नमुना' },
  'order.bulk': { hi: 'बल्क', mr: 'मोठ्या प्रमाणात' },
  'order.payOnline': { hi: 'ऑनलाइन भुगतान', mr: 'ऑनलाइन पेमेंट' },
  'order.cod': { hi: 'कैश ऑन डिलीवरी', mr: 'कॅश ऑन डिलिव्हरी' },
  'order.quantity': { hi: 'मात्रा', mr: 'प्रमाण' },
  'order.placeOrder': { hi: 'ऑर्डर करें', mr: 'ऑर्डर करा' },
  'settings.appearance': { hi: 'दिखावट', mr: 'देखावा' },
  'settings.darkMode': { hi: 'डार्क मोड', mr: 'डार्क मोड' },
  'settings.language': { hi: 'भाषा', mr: 'भाषा' },
  'settings.languageSub': { hi: 'ऐप की भाषा चुनें', mr: 'अ‍ॅपची भाषा निवडा' },
  'settings.notifications': { hi: 'नोटिफिकेशन', mr: 'सूचना' },
  'settings.logout': { hi: 'लॉग आउट', mr: 'लॉग आउट' },
  'pwa.install': { en: 'Install app', hi: 'ऐप इंस्टॉल करें', mr: 'अ‍ॅप इंस्टॉल करा' },
  'pwa.installGo': { en: 'Install', hi: 'इंस्टॉल', mr: 'इंस्टॉल' },

  /* ── Index demo landing (EN source in HTML; hi/mr curated) ── */
  'demo.nav.how': { hi: 'कैसे काम करता है', mr: 'कसे काम करते' },
  'demo.nav.capabilities': { hi: 'सुविधाएँ', mr: 'सुविधा' },
  'demo.nav.market': { hi: 'लाइव मार्केट', mr: 'लाइव्ह मार्केट' },
  'demo.nav.roles': { hi: 'खरीदें और बेचें', mr: 'खरेदी व विक्री' },
  'demo.nav.portal': { hi: 'पोर्टल', mr: 'पोर्टल' },
  'demo.nav.trust': { hi: 'भरोसा', mr: 'विश्वास' },
  'demo.nav.login': { hi: 'लॉगिन', mr: 'लॉगिन' },
  'demo.nav.start': { hi: 'ट्रेड शुरू करें', mr: 'ट्रेड सुरू करा' },
  'demo.hero.copy': {
    hi: 'भारत का प्रमाणित एग्री मार्केटप्लेस — सत्यापित दुकानों के साथ खरीदें, मोल-भाव करें, भुगतान करें, ट्रैक करें और फसल बेचें।',
    mr: 'भारताचे प्रमाणित अॅग्री मार्केटप्लेस — पडताळलेल्या दुकानांसोबत खरेदी, घासाघीस, पेमेंट, ट्रॅक आणि पीक विक्री.'
  },
  'demo.hero.browse': { hi: 'लाइव मार्केट देखें', mr: 'लाइव्ह मार्केट पहा' },
  'demo.hero.account': { hi: 'मुफ़्त अकाउंट खोलें', mr: 'मोफत खाते उघडा' },
  'demo.proof.listings': { hi: 'लाइव लिस्टिंग', mr: 'लाइव्ह लिस्टिंग' },
  'demo.proof.compliance': { hi: 'अनुपालन स्तंभ', mr: 'अनुपालन स्तंभ' },
  'demo.proof.pay': { hi: 'कैशफ्री ऑनलाइन', mr: 'कॅशफ्री ऑनलाइन' },
  'demo.proof.modules': { hi: 'पोर्टल मॉड्यूल', mr: 'पोर्टल मॉड्यूल' },
  'demo.how.kicker': { hi: 'सरल रास्ता', mr: 'सोपा मार्ग' },
  'demo.how.title': { hi: 'खोज से डिलीवरी तक', mr: 'शोध ते डिलिव्हरीपर्यंत' },
  'demo.how.lead': {
    hi: 'तीन साफ़ कदम — वही फ्लो जो खरीदार और विक्रेता हर दिन आरवेक्स पोर्टल में इस्तेमाल करते हैं।',
    mr: 'तीन स्पष्ट पावले — तोच फ्लो जो खरेदीदार व विक्रेते दररोज आरवेक्स पोर्टलमध्ये वापरतात.'
  },
  'demo.how.s1': { hi: 'खोजें', mr: 'शोधा' },
  'demo.how.s1p': {
    hi: 'प्रोडक्ट या शॉप ID खोजें, कैटेगरी फ़िल्टर करें, पसंदीदा सेव करें और सत्यापित दुकानें खोलें।',
    mr: 'प्रॉडक्ट किंवा शॉप ID शोधा, श्रेणी फिल्टर करा, आवडते जतन करा आणि पडताळलेली दुकाने उघडा.'
  },
  'demo.how.s2': { hi: 'सौदा और भुगतान', mr: 'डील व पेमेंट' },
  'demo.how.s2p': {
    hi: 'अभी खरीदें, कीमत पर मोल-भाव करें (RFQ/डील्स), कैशफ्री से ऑनलाइन भुगतान या COD चुनें।',
    mr: 'आता खरेदी करा, किंमतीवर घासाघीस करा (RFQ/डील्स), कॅशफ्रीने ऑनलाइन पेमेंट किंवा COD निवडा.'
  },
  'demo.how.s3': { hi: 'ट्रैक और चैट', mr: 'ट्रॅक व चॅट' },
  'demo.how.s3p': {
    hi: 'शिपमेंट फॉलो करें, अलर्ट पाएँ, विक्रेताओं से मैसेज करें और पते एक अकाउंट से मैनेज करें।',
    mr: 'शिपमेंट फॉलो करा, अलर्ट मिळवा, विक्रेत्यांशी मेसेज करा आणि पत्ते एका खात्यातून व्यवस्थापित करा.'
  },
  'demo.theater.kicker': { hi: 'इंटरैक्टिव टूर', mr: 'इंटरॅक्टिव्ह टूर' },
  'demo.theater.title': { hi: 'सुविधा चुनें। फायदा देखें।', mr: 'सुविधा निवडा. फायदा पहा.' },
  'demo.theater.lead': {
    hi: 'हर पैनल आरवेक्स पोर्टल के असली मॉड्यूल से जुड़ा है — सिर्फ़ मार्केटिंग नहीं।',
    mr: 'प्रत्येक पॅनेल आरवेक्स पोर्टलच्या खऱ्या मॉड्यूलशी जोडलेले आहे — फक्त मार्केटिंग नाही.'
  },
  'demo.theater.open': { hi: 'पोर्टल में खोलें', mr: 'पोर्टलमध्ये उघडा' },
  'demo.spot.kicker': { hi: 'स्पॉटलाइट', mr: 'स्पॉटलाइट' },
  'demo.spot.title': { hi: 'लाइव फ्लोर से चुने हुए', mr: 'लाइव्ह फ्लोअरवरील निवडक' },
  'demo.spot.lead': {
    hi: 'कैटलॉग से ऑटो-रोटेटिंग पिक्स — किसी भी कार्ड पर क्लिक कर पोर्टल खोलें।',
    mr: 'कॅटलॉगमधील ऑटो-रोटेटिंग निवडी — कोणत्याही कार्डवर क्लिक करून पोर्टल उघडा.'
  },
  'demo.spot.cta': { hi: 'ट्रेड हब में देखें', mr: 'ट्रेड हबमध्ये पहा' },
  'demo.feat.kicker': { hi: 'पूरा स्टैक फ़ायदा', mr: 'पूर्ण स्टॅक फायदा' },
  'demo.feat.title': { hi: 'ग्रिड से कहीं ज़्यादा गहराई', mr: 'ग्रिडपेक्षा खूप जास्त खोली' },
  'demo.feat.lead': {
    hi: 'खोज, डील्स, भुगतान, लॉजिस्टिक्स, चैट और अनुपालन — एक ही अकाउंट।',
    mr: 'शोध, डील्स, पेमेंट, लॉजिस्टिक्स, चॅट आणि अनुपालन — एकच खाते.'
  },
  'demo.market.kicker': { hi: 'लाइव डेटा', mr: 'लाइव्ह डेटा' },
  'demo.market.title': { hi: 'अभी क्या ट्रेड हो रहा है', mr: 'आता काय ट्रेड होत आहे' },
  'demo.market.lead': {
    hi: 'पोर्टल जैसे ही कैटलॉग और शॉप्स API से — कभी भी रिफ्रेश करें।',
    mr: 'पोर्टलसारख्याच कॅटलॉग व शॉप्स API वरून — कधीही रिफ्रेश करा.'
  },
  'demo.market.refresh': { hi: 'रिफ्रेश', mr: 'रिफ्रेश' },
  'demo.market.search': { hi: 'प्रोडक्ट या दुकान खोजें…', mr: 'प्रॉडक्ट किंवा दुकान शोधा…' },
  'demo.roles.kicker': { hi: 'दो पक्ष, एक प्लेटफ़ॉर्म', mr: 'दोन बाजू, एक प्लॅटफॉर्म' },
  'demo.roles.title': { hi: 'खरीदार और विक्रेता दोनों के लिए', mr: 'खरेदीदार व विक्रेते दोघांसाठी' },
  'demo.roles.lead': {
    hi: 'चाहे थोक मसाले लें या खेत की फसल लिस्ट करें — KYC भूमिकाएँ ट्रेड को गंभीर रखती हैं।',
    mr: 'मग तो मोठ्या प्रमाणात मसाले घ्या किंवा शेतातील पीक लिस्ट करा — KYC भूमिका ट्रेड गंभीर ठेवतात.'
  },
  'demo.roles.buyer': { hi: 'खरीदारों के लिए', mr: 'खरेदीदारांसाठी' },
  'demo.roles.buyerTitle': { hi: 'भरोसे के साथ सोर्स करें', mr: 'विश्वासाने सोर्स करा' },
  'demo.roles.buyerCta': { hi: 'खरीदार अकाउंट बनाएँ', mr: 'खरेदीदार खाते तयार करा' },
  'demo.roles.seller': { hi: 'विक्रेताओं के लिए', mr: 'विक्रेत्यांसाठी' },
  'demo.roles.sellerTitle': { hi: 'लिस्ट करें. बेचें. बढ़ाएँ.', mr: 'लिस्ट करा. विका. वाढवा.' },
  'demo.roles.sellerCta': { hi: 'बेचना शुरू करें', mr: 'विक्री सुरू करा' },
  'demo.compare.kicker': { hi: 'क्यों बदलें', mr: 'का बदलावे' },
  'demo.compare.title': { hi: 'पुराना थोक बनाम आरवेक्स पोर्टल', mr: 'जुनी घाऊक विरुद्ध आरवेक्स पोर्टल' },
  'demo.compare.lead': { hi: 'एक नज़र में फ़ायदा साफ़ दिखे।', mr: 'एका नजरेत फायदा स्पष्ट दिसावा.' },
  'demo.compare.old': { hi: 'पारंपरिक रास्ता', mr: 'पारंपरिक मार्ग' },
  'demo.compare.new': { hi: 'आरवेक्स ग्लोबल', mr: 'आरवेक्स ग्लोबल' },
  'demo.stack.kicker': { hi: 'पोर्टल के अंदर', mr: 'पोर्टलच्या आत' },
  'demo.stack.title': { hi: 'एक लॉगिन. बारह वर्कस्पेस.', mr: 'एक लॉगिन. बारा वर्कस्पेस.' },
  'demo.stack.lead': {
    hi: 'मॉड्यूल पर होवर करें — लॉगिन के बाद ग्राहक क्या अनलॉक करते हैं देखें।',
    mr: 'मॉड्यूलवर होव्हर करा — लॉगिननंतर ग्राहक काय अनलॉक करतात ते पहा.'
  },
  'demo.trust.kicker': { hi: 'अनुपालन और भरोसा', mr: 'अनुपालन व विश्वास' },
  'demo.trust.title': { hi: 'कागज़ पर भी प्रोफेशनल ट्रेड', mr: 'कागदावरही प्रोफेशनल ट्रेड' },
  'demo.trust.lead': {
    hi: 'आरवेक्स प्रमाणित एग्री ट्रेडिंग अनुभव के रूप में बना है — सामान्य क्लासिफाइड नहीं।',
    mr: 'आरवेक्स प्रमाणित अॅग्री ट्रेडिंग अनुभव म्हणून बनवले आहे — सामान्य क्लासिफाइड नाही.'
  },
  'demo.sell.kicker': { hi: 'जब आप तैयार हों', mr: 'जेव्हा तुम्ही तयार असाल' },
  'demo.sell.title': { hi: 'पोर्टल खोलें. आज ही ट्रेड शुरू करें.', mr: 'पोर्टल उघडा. आजच ट्रेड सुरू करा.' },
  'demo.sell.lead': {
    hi: 'होम, ट्रेड, पसंदीदा, ट्रैक, डील्स, शॉप, रेफर और मैसेज — एक ही अकाउंट।',
    mr: 'होम, ट्रेड, आवडते, ट्रॅक, डील्स, शॉप, रेफर आणि मेसेज — एकच खाते.'
  },
  'demo.sell.cta': { hi: 'मेरा अकाउंट खोलें', mr: 'माझे खाते उघडा' },
  'demo.sell.wa': { hi: 'व्हाट्सऐप सपोर्ट', mr: 'व्हाट्सअॅप सपोर्ट' },
};

let _axLang = 'en';
try { _axLang = localStorage.getItem('ax_lang') || 'en'; } catch (e) { _axLang = 'en'; }
if (!AX_LANGS[_axLang]) _axLang = 'en';

function t(key, fallback) {
  if (_axLang === 'en') return fallback != null ? fallback : (AX_I18N[key] && AX_I18N[key].en) || key;
  const entry = AX_I18N[key];
  if (entry && entry[_axLang]) return entry[_axLang];
  return (entry && entry.en) || (fallback != null ? fallback : key);
}
function axCurrentLang() { return _axLang; }

function axApplyI18n(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach(function (el) {
    const key = el.getAttribute('data-i18n');
    if (!el.hasAttribute('data-i18n-en')) el.setAttribute('data-i18n-en', el.textContent.trim());
    el.textContent = _axLang === 'en' ? el.getAttribute('data-i18n-en') : t(key, el.getAttribute('data-i18n-en'));
  });
  root.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
    const key = el.getAttribute('data-i18n-ph');
    if (!el.hasAttribute('data-i18n-ph-en')) el.setAttribute('data-i18n-ph-en', el.getAttribute('placeholder') || '');
    el.setAttribute('placeholder', _axLang === 'en' ? el.getAttribute('data-i18n-ph-en') : t(key, el.getAttribute('data-i18n-ph-en')));
  });
  root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
    const key = el.getAttribute('data-i18n-title');
    if (!el.hasAttribute('data-i18n-title-en')) el.setAttribute('data-i18n-title-en', el.getAttribute('title') || '');
    el.setAttribute('title', _axLang === 'en' ? el.getAttribute('data-i18n-title-en') : t(key, el.getAttribute('data-i18n-title-en')));
  });
}

/* ═══════════════════════════════════════════════════════════════
   LIVE FULL-PAGE TRANSLATOR (free API)
   ═══════════════════════════════════════════════════════════════ */
var _axTxOrigText = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
var _axTxOrigAttr = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
var _axTxCache = { hi: {}, mr: {} };
var _axTxBusy = false;
var _axTxQueued = false;
var _axTxTimer = null;
var _axTxObs = null;
var _axTxSkip = false;

try {
  var _rawCache = localStorage.getItem('ax_tx_cache_v2');
  if (_rawCache) {
    var parsed = JSON.parse(_rawCache);
    if (parsed && parsed.hi) _axTxCache.hi = parsed.hi;
    if (parsed && parsed.mr) _axTxCache.mr = parsed.mr;
  }
} catch (e) {}

function _axTxPersistCache() {
  try {
    // Cap cache size so localStorage stays healthy
    ['hi', 'mr'].forEach(function (lang) {
      var keys = Object.keys(_axTxCache[lang] || {});
      if (keys.length > 800) {
        keys.slice(0, keys.length - 600).forEach(function (k) { delete _axTxCache[lang][k]; });
      }
    });
    localStorage.setItem('ax_tx_cache_v2', JSON.stringify(_axTxCache));
  } catch (e) {}
}

function _axTxShouldSkipEl(el) {
  if (!el || el.nodeType !== 1) return true;
  var tag = (el.tagName || '').toLowerCase();
  if (/^(script|style|noscript|code|pre|svg|math|textarea)$/.test(tag)) return true;
  if (el.closest && el.closest('[data-no-translate], .ax-lang-opt, code, pre, script, style, svg')) return true;
  if (el.isContentEditable) return true;
  // Already handled by curated dictionary — don't double-translate
  if (el.hasAttribute('data-i18n') || el.hasAttribute('data-i18n-ph') || el.hasAttribute('data-i18n-title')) return true;
  return false;
}

function _axTxIsTranslatable(str) {
  if (!str) return false;
  var s = String(str).replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 400) return false;
  // Skip pure numbers / codes / ARNs / emails / urls / shop IDs
  if (/^[\d\s.,₹$%+\-:/|#]+$/.test(s)) return false;
  if (/^(ARN|SHOP-AX|AX)[-A-Z0-9]+$/i.test(s)) return false;
  if (/@|https?:\/\/|www\./i.test(s)) return false;
  if (/^SHOP-AX-/i.test(s)) return false;
  // Must contain Latin letters (English source). Skip if already Devanagari-only.
  if (!/[A-Za-z]/.test(s)) return false;
  // Keep brand intact
  if (/^aarvex(\s+global)?$/i.test(s)) return false;
  return true;
}

function _axTxNorm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

async function _axTxApiGoogle(text, tl) {
  var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' +
    encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(text);
  var res = await fetch(url);
  if (!res.ok) throw new Error('gtx ' + res.status);
  var data = await res.json();
  var out = '';
  if (data && data[0]) {
    for (var i = 0; i < data[0].length; i++) {
      if (data[0][i] && data[0][i][0]) out += data[0][i][0];
    }
  }
  if (!out) throw new Error('gtx empty');
  return out;
}

async function _axTxApiMyMemory(text, tl) {
  var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=en|' + encodeURIComponent(tl);
  var res = await fetch(url);
  if (!res.ok) throw new Error('mymemory ' + res.status);
  var data = await res.json();
  var out = data && data.responseData && data.responseData.translatedText;
  if (!out || /INVALID|QUERY LENGTH/i.test(out)) throw new Error('mymemory bad');
  return out;
}

async function _axTxOne(text, tl) {
  var key = _axTxNorm(text);
  if (_axTxCache[tl] && _axTxCache[tl][key]) return _axTxCache[tl][key];
  var translated = null;
  try {
    translated = await _axTxApiGoogle(key, tl);
  } catch (e1) {
    try {
      translated = await _axTxApiMyMemory(key, tl);
    } catch (e2) {
      return key; // leave English on total failure
    }
  }
  if (!_axTxCache[tl]) _axTxCache[tl] = {};
  _axTxCache[tl][key] = translated;
  return translated;
}

async function _axTxBatch(texts, tl) {
  var unique = [];
  var seen = {};
  texts.forEach(function (t) {
    var k = _axTxNorm(t);
    if (!k || seen[k] || (_axTxCache[tl] && _axTxCache[tl][k])) return;
    seen[k] = 1;
    unique.push(k);
  });
  var i = 0;
  var concurrency = 4;
  async function worker() {
    while (i < unique.length) {
      var idx = i++;
      var src = unique[idx];
      await _axTxOne(src, tl);
      // gentle throttle
      await new Promise(function (r) { setTimeout(r, 40); });
    }
  }
  var workers = [];
  for (var w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  _axTxPersistCache();
}

function _axTxCollect(root) {
  var jobs = []; // { type:'text'|'attr', node, attr?, original }
  root = root || document.body;
  if (!root) return jobs;

  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      if (!node || !node.parentElement) return NodeFilter.FILTER_REJECT;
      if (_axTxShouldSkipEl(node.parentElement)) return NodeFilter.FILTER_REJECT;
      var raw = node.nodeValue;
      if (!raw || !raw.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  var n;
  while ((n = walker.nextNode())) {
    var cur = n.nodeValue;
    var original = (_axTxOrigText && _axTxOrigText.get(n)) || cur;
    if (_axTxOrigText && !_axTxOrigText.has(n)) {
      // Only lock English originals (when switching from EN, or first see)
      if (_axLang === 'en' || /[A-Za-z]/.test(cur)) _axTxOrigText.set(n, cur);
      original = _axTxOrigText.get(n) || cur;
    }
    if (_axTxIsTranslatable(original)) {
      jobs.push({ type: 'text', node: n, original: original });
    }
  }

  root.querySelectorAll('input[placeholder], textarea[placeholder], [title], [aria-label]').forEach(function (el) {
    if (_axTxShouldSkipEl(el)) return;
    ['placeholder', 'title', 'aria-label'].forEach(function (attr) {
      if (!el.hasAttribute(attr)) return;
      if (attr === 'placeholder' && el.hasAttribute('data-i18n-ph')) return;
      if (attr === 'title' && el.hasAttribute('data-i18n-title')) return;
      var cur = el.getAttribute(attr) || '';
      var mapKey = attr;
      var bag = _axTxOrigAttr && _axTxOrigAttr.get(el);
      if (!bag) bag = {};
      if (!bag[mapKey]) {
        if (_axLang === 'en' || /[A-Za-z]/.test(cur)) bag[mapKey] = cur;
      }
      if (_axTxOrigAttr) _axTxOrigAttr.set(el, bag);
      var original = bag[mapKey] || cur;
      if (_axTxIsTranslatable(original)) {
        jobs.push({ type: 'attr', node: el, attr: attr, original: original });
      }
    });
  });

  return jobs;
}

function _axTxRestoreEnglish(root) {
  root = root || document.body;
  if (!root || !_axTxOrigText) return;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var n;
  while ((n = walker.nextNode())) {
    if (_axTxOrigText.has(n)) n.nodeValue = _axTxOrigText.get(n);
  }
  if (_axTxOrigAttr) {
    root.querySelectorAll('input, textarea, [title], [aria-label]').forEach(function (el) {
      var bag = _axTxOrigAttr.get(el);
      if (!bag) return;
      Object.keys(bag).forEach(function (attr) {
        el.setAttribute(attr, bag[attr]);
      });
    });
  }
}

async function axLiveTranslatePage(root) {
  if (_axLang === 'en') {
    _axTxSkip = true;
    try { _axTxRestoreEnglish(root || document.body); } finally { _axTxSkip = false; }
    return;
  }
  if (_axTxBusy) { _axTxQueued = true; return; }
  _axTxBusy = true;
  _axTxSkip = true;
  try {
    var jobs = _axTxCollect(root || document.body);
    if (!jobs.length) return;
    var texts = jobs.map(function (j) { return j.original; });
    await _axTxBatch(texts, _axLang);
    jobs.forEach(function (j) {
      var key = _axTxNorm(j.original);
      var tr = (_axTxCache[_axLang] && _axTxCache[_axLang][key]) || j.original;
      if (j.type === 'text' && j.node && j.node.parentNode) {
        // Preserve leading/trailing whitespace from original node value shape
        var origNode = (_axTxOrigText && _axTxOrigText.get(j.node)) || j.node.nodeValue || '';
        var lead = (origNode.match(/^\s*/) || [''])[0];
        var trail = (origNode.match(/\s*$/) || [''])[0];
        j.node.nodeValue = lead + tr + trail;
      } else if (j.type === 'attr' && j.node && j.attr) {
        j.node.setAttribute(j.attr, tr);
      }
    });
  } catch (e) {
    console.warn('[i18n] live translate failed', e);
  } finally {
    _axTxSkip = false;
    _axTxBusy = false;
    if (_axTxQueued) {
      _axTxQueued = false;
      axScheduleLiveTranslate(300);
    }
  }
}

function axScheduleLiveTranslate(delay) {
  if (_axTxTimer) clearTimeout(_axTxTimer);
  _axTxTimer = setTimeout(function () {
    _axTxTimer = null;
    axLiveTranslatePage(document.body);
  }, delay == null ? 450 : delay);
}

function axStartLiveTranslateObserver() {
  if (_axTxObs || typeof MutationObserver === 'undefined' || !document.body) return;
  _axTxObs = new MutationObserver(function () {
    if (_axTxSkip || _axLang === 'en') return;
    axScheduleLiveTranslate(700);
  });
  _axTxObs.observe(document.body, { childList: true, subtree: true, characterData: false });
}

function axSetLanguage(lang) {
  if (!AX_LANGS[lang]) lang = 'en';
  _axLang = lang;
  try { localStorage.setItem('ax_lang', lang); } catch (e) {}
  document.documentElement.setAttribute('lang', lang);
  axApplyI18n(document);
  document.querySelectorAll('.ax-lang-opt').forEach(function (b) {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
  if (lang === 'en') {
    axLiveTranslatePage(document.body);
    if (typeof showToast === 'function') showToast('English', 'success');
  } else {
    if (typeof showToast === 'function') showToast((AX_LANGS[lang] || lang) + ' — translating page…', 'success');
    axScheduleLiveTranslate(80);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  document.documentElement.setAttribute('lang', _axLang);
  axApplyI18n(document);
  document.querySelectorAll('.ax-lang-opt').forEach(function (b) {
    b.classList.toggle('active', b.dataset.lang === _axLang);
  });
  axStartLiveTranslateObserver();
  if (_axLang !== 'en') axScheduleLiveTranslate(200);
  // Re-run after panel switches / catalogue renders
  document.addEventListener('ax:panel-changed', function () {
    axApplyI18n(document);
    if (_axLang !== 'en') axScheduleLiveTranslate(350);
  });
});

window.axApplyI18n = axApplyI18n;
window.axSetLanguage = axSetLanguage;
window.axLiveTranslatePage = axLiveTranslatePage;
window.axScheduleLiveTranslate = axScheduleLiveTranslate;
window.axCurrentLang = axCurrentLang;
window.t = window.t || t;
window.AX_LANGS = AX_LANGS;
