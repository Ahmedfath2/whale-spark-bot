// ============================================================
// Smart Money Momentum Bot
// يفحص السوق بحثًا عن قفزات حجم تداول + تأكيد حركة سعرية
// + تجميع محافظ "أموال ذكية" على نفس العملة — ويبعت تنبيه تليجرام
// فقط للحالات النادرة اللي عدّت كل الفلاتر
// ============================================================

const fs = require('fs');
const path = require('path');

// ---------- إعدادات قابلة للتعديل ----------
const CONFIG = {
  COINS_TO_SCAN: 250,           // أعلى عدد عملات بالحجم نفحصها كل مرة
  MIN_SAMPLES_BEFORE_FLAG: 4,   // أقل عدد قراءات تاريخية قبل ما نثق بالمتوسط
  VOLUME_SPIKE_MULTIPLIER: 3,   // الحجم الحالي لازم يكون X أضعاف المتوسط
  MIN_PRICE_MOVE_PCT: 4,        // نسبة تحرك السعر 24 ساعة المطلوبة كتأكيد
  MIN_DAILY_VOLUME_USD: 2_000_000, // حد أدنى للسيولة (يمنع عملات ميتة/يسهل التلاعب فيها)
  COOLDOWN_HOURS: 24,           // ما نبعتش تنبيه تاني لنفس العملة قبل مرور كذا ساعة
  MAX_HISTORY_SAMPLES: 96,      // أقصى عدد قراءات نحتفظ بيها لكل عملة (لمنع تضخم الملف)
  REQUIRE_WHALE_CLUSTER_FOR_ALERT: false, // true = ما يبعتش تنبيه أبدًا غير لو فيه تجميع محافظ
  MIN_WALLETS_FOR_CLUSTER: 2,   // أقل عدد محافظ متتبعة لازم تكون اشترت لنفس العملة
};

const STATE_PATH = path.join(__dirname, 'state.json');
const WATCHLIST_PATH = path.join(__dirname, 'watchlist.json');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY; // اختياري لتفعيل فلتر المحافظ

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return fallback; }
}
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function fetchTopCoins() {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=${CONFIG.COINS_TO_SCAN}&page=1&price_change_percentage=24h&sparkline=false`;
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko markets fetch failed: ${res.status}`);
  return res.json();
}

async function fetchCoinPlatforms(coinId) {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.platforms || null;
  } catch (e) { return null; }
}

// يتحقق هل محافظ من قائمة المتابعة اشترت هالعملة (على إيثريوم) في آخر 48 ساعة
async function checkWhaleCluster(contractAddress, wallets) {
  if (!ETHERSCAN_API_KEY || !contractAddress || !wallets || wallets.length === 0) {
    return { checked: false, buyers: [] };
  }
  const cutoff = Date.now() / 1000 - 48 * 3600;
  const buyers = [];

  for (const wallet of wallets) {
    try {
      const url = `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=${contractAddress}&address=${wallet.address}&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== '1' || !Array.isArray(data.result)) continue;

      const recentBuy = data.result.find(tx =>
        tx.to.toLowerCase() === wallet.address.toLowerCase() &&
        parseInt(tx.timeStamp, 10) >= cutoff
      );
      if (recentBuy) buyers.push(wallet.label || wallet.address);
    } catch (e) { /* تجاهل خطأ محفظة واحدة وكمل الباقي */ }
    await new Promise(r => setTimeout(r, 250)); // احترام حد Etherscan (5 طلبات/ثانية)
  }
  return { checked: true, buyers };
}

async function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID غير مضبوطين — تخطي الإرسال.');
    console.log(text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function main() {
  const state = loadJSON(STATE_PATH, { volumeHistory: {}, alerted: {} });
  const watchlist = loadJSON(WATCHLIST_PATH, { wallets: [] });

  console.log('جارٍ جلب بيانات السوق...');
  const coins = await fetchTopCoins();
  const now = Date.now();
  const alertsSent = [];

  for (const coin of coins) {
    const id = coin.id;
    const volume = coin.total_volume || 0;
    const priceChange = coin.price_change_percentage_24h || 0;

    if (!state.volumeHistory[id]) state.volumeHistory[id] = [];
    const history = state.volumeHistory[id];
    
if (!state.supplyData) state.supplyData = {};
        state.supplyData[id] = {
          symbol: (coin.symbol || '').toUpperCase(),
          name: coin.name,
          supply: coin.circulating_supply || 0
        };
    // تحقق من الشروط الأساسية قبل حتى النظر في التاريخ
    const passesLiquidity = volume >= CONFIG.MIN_DAILY_VOLUME_USD;
    const passesPriceMove = Math.abs(priceChange) >= CONFIG.MIN_PRICE_MOVE_PCT;

    if (passesLiquidity && passesPriceMove && history.length >= CONFIG.MIN_SAMPLES_BEFORE_FLAG) {
      const baseline = average(history);
      const spikeRatio = baseline > 0 ? volume / baseline : 0;

      if (spikeRatio >= CONFIG.VOLUME_SPIKE_MULTIPLIER) {
        const lastAlert = state.alerted[id] || 0;
        const cooldownMs = CONFIG.COOLDOWN_HOURS * 3600 * 1000;

        if (now - lastAlert > cooldownMs) {
          // فحص تجميع المحافظ الذكية (لو مفعّل ومفتاح Etherscan موجود)
          let clusterInfo = { checked: false, buyers: [] };
          if (watchlist.wallets.length > 0 && ETHERSCAN_API_KEY) {
            const platforms = await fetchCoinPlatforms(id);
            const contract = platforms && platforms.ethereum;
            if (contract) {
              clusterInfo = await checkWhaleCluster(contract, watchlist.wallets);
            }
          }

          const hasCluster = clusterInfo.buyers.length >= CONFIG.MIN_WALLETS_FOR_CLUSTER;
          const shouldAlert = CONFIG.REQUIRE_WHALE_CLUSTER_FOR_ALERT ? hasCluster : true;

          if (shouldAlert) {
            const tier = hasCluster ? '🔴 S (ثقة عالية جدًا)' : '🟠 A (زخم مؤكد)';
            const msg =
              `<b>${tier}</b>\n` +
              `<b>${coin.name} (${coin.symbol.toUpperCase()})</b>\n` +
              `📈 السعر: $${coin.current_price} (${priceChange > 0 ? '+' : ''}${priceChange.toFixed(1)}%)\n` +
              `📊 قفزة حجم التداول: ${spikeRatio.toFixed(1)}x عن المعتاد\n` +
              `💧 حجم 24h: $${Math.round(volume).toLocaleString()}\n` +
              (clusterInfo.checked
                ? (hasCluster
                    ? `🐋 محافظ ذكية اشترت مؤخرًا: ${clusterInfo.buyers.join(', ')}\n`
                    : `🐋 لا توجد محافظ متتبعة اشترت هذي العملة\n`)
                : '') +
              `🔗 https://www.coingecko.com/en/coins/${id}`;

            await sendTelegramAlert(msg);
            alertsSent.push(id);
            state.alerted[id] = now;
          }
        }
      }
    }

    // تحديث السجل التاريخي دائمًا (بغض النظر هل بعثنا تنبيه ولا لا)
    history.push(volume);
    if (history.length > CONFIG.MAX_HISTORY_SAMPLES) history.shift();
  }

  saveJSON(STATE_PATH, state);
  console.log(`اكتمل الفحص. تنبيهات مُرسلة: ${alertsSent.length ? alertsSent.join(', ') : 'لا شيء'}`);
}

main().catch(err => {
  console.error('خطأ في تشغيل البوت:', err);
  process.exit(1);
});
