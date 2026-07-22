const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  STANDALONE XAU ALGO BOT — Tự quét M5, tính SMC + 4EMA, báo Telegram
//  Nguồn dữ liệu: Binance Futures XAUUSDT (≈ XAU/USD — Sát giá OANDA)
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOL = 'XAUUSDT';
const INTERVAL = '5m';
const SWING_LENGTH = 7;
const BOX_WIDTH = 7;
const HISTORY_KEEP = 7;
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 phút

// ============================================================
//  TRẠNG THÁI TOÀN CỤC
// ============================================================
let supplyZones = [];
let demandZones = [];
let alertedBOS = new Set(); // Chống spam: mỗi BOS chỉ báo 1 lần
let lastScanTime = null;
let scanCount = 0;
const STARTUP_TIME = Date.now();

// ============================================================
//  1. LẤY DỮ LIỆU NẾN TỪ BINANCE
// ============================================================
async function fetchCandles(limit = 500) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Binance API error: ' + JSON.stringify(data));
    return data.map(c => ({
        time: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5])
    }));
}

// ============================================================
//  2. TÍNH EMA
// ============================================================
function calcEMA(closes, period) {
    const k = 2 / (period + 1);
    const ema = [closes[0]];
    for (let i = 1; i < closes.length; i++) {
        ema.push(closes[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
}

// ============================================================
//  3. TÌM SWING HIGH / SWING LOW (PivotHigh / PivotLow)
// ============================================================
function findSwingHighs(highs, length) {
    const swings = [];
    for (let i = length; i < highs.length - length; i++) {
        let isSwing = true;
        for (let j = 1; j <= length; j++) {
            if (highs[i] < highs[i - j] || highs[i] < highs[i + j]) {
                isSwing = false;
                break;
            }
        }
        if (isSwing) swings.push({ index: i, value: highs[i] });
    }
    return swings;
}

function findSwingLows(lows, length) {
    const swings = [];
    for (let i = length; i < lows.length - length; i++) {
        let isSwing = true;
        for (let j = 1; j <= length; j++) {
            if (lows[i] > lows[i - j] || lows[i] > lows[i + j]) {
                isSwing = false;
                break;
            }
        }
        if (isSwing) swings.push({ index: i, value: lows[i] });
    }
    return swings;
}

// ============================================================
//  4. TÍNH ATR (Average True Range)
// ============================================================
function calcATR(candles, period = 50) {
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        );
        trs.push(tr);
    }
    // Simple moving average of TR for the last 'period' values
    if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / trs.length;
    const slice = trs.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

// ============================================================
//  5. XÂY DỰNG VÙNG SUPPLY / DEMAND (SMC Zones)
// ============================================================
function buildZones(candles, swingHighs, swingLows, atr) {
    const atrBuffer = atr * (BOX_WIDTH / 10);
    const supply = [];
    const demand = [];

    // Supply zones from Swing Highs
    for (const sh of swingHighs.slice(-HISTORY_KEEP)) {
        const top = sh.value;
        const bottom = top - atrBuffer;
        const poi = (top + bottom) / 2;
        // Check overlapping
        let overlapping = false;
        for (const zone of supply) {
            const zonePoi = (zone.top + zone.bottom) / 2;
            if (Math.abs(poi - zonePoi) < atr * 2) {
                overlapping = true;
                break;
            }
        }
        if (!overlapping) {
            supply.push({ top, bottom, poi, index: sh.index, broken: false });
        }
    }

    // Demand zones from Swing Lows
    for (const sl of swingLows.slice(-HISTORY_KEEP)) {
        const bottom = sl.value;
        const top = bottom + atrBuffer;
        const poi = (top + bottom) / 2;
        let overlapping = false;
        for (const zone of demand) {
            const zonePoi = (zone.top + zone.bottom) / 2;
            if (Math.abs(poi - zonePoi) < atr * 2) {
                overlapping = true;
                break;
            }
        }
        if (!overlapping) {
            demand.push({ top, bottom, poi, index: sl.index, broken: false });
        }
    }

    return { supply, demand };
}

// ============================================================
//  6. KIỂM TRA BOS (Break of Structure)
// ============================================================
function detectBOS(candles, supply, demand) {
    const signals = [];
    const currentCandle = candles[candles.length - 1];
    const price = currentCandle.close;

    // Check Supply BOS (LONG signal — price breaks above supply)
    for (const zone of supply) {
        if (!zone.broken && price >= zone.top) {
            zone.broken = true;
            const bosKey = `LONG_${zone.top.toFixed(2)}_${zone.index}`;
            if (!alertedBOS.has(bosKey)) {
                alertedBOS.add(bosKey);
                signals.push({
                    signal: 'LONG',
                    msg: 'Giá phá vỡ BOS Supply — Canh LONG',
                    price: price.toFixed(2),
                    zoneTop: zone.top.toFixed(2),
                    zoneBottom: zone.bottom.toFixed(2)
                });
            }
        }
    }

    // Check Demand BOS (SHORT signal — price breaks below demand)
    for (const zone of demand) {
        if (!zone.broken && price <= zone.bottom) {
            zone.broken = true;
            const bosKey = `SHORT_${zone.bottom.toFixed(2)}_${zone.index}`;
            if (!alertedBOS.has(bosKey)) {
                alertedBOS.add(bosKey);
                signals.push({
                    signal: 'SHORT',
                    msg: 'Giá phá vỡ BOS Demand — Canh SHORT',
                    price: price.toFixed(2),
                    zoneTop: zone.top.toFixed(2),
                    zoneBottom: zone.bottom.toFixed(2)
                });
            }
        }
    }

    return signals;
}

// ============================================================
//  7. GỬI TELEGRAM
// ============================================================
async function sendTelegram(text) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.log('[TELEGRAM SKIP] Missing BOT_TOKEN or CHAT_ID');
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text,
                parse_mode: 'HTML'
            })
        });
        const data = await res.json();
        if (!data.ok) console.error('[TELEGRAM ERROR]', data.description);
    } catch (err) {
        console.error('[TELEGRAM SEND ERROR]', err.message);
    }
}

function formatSignalMessage(sig, ema147, ema258, ema369) {
    const emoji = sig.signal === 'LONG' ? '🟢🔼' : '🔴🔽';
    const action = sig.signal === 'LONG' ? 'CANH MUA (LONG)' : 'CANH BÁN (SHORT)';
    
    // Xác định vị trí giá so với EMA
    const price = parseFloat(sig.price);
    let emaContext = '';
    if (price > ema147 && price > ema258 && price > ema369) {
        emaContext = '✅ Giá trên cả 3 EMA → Xu hướng TĂNG mạnh';
    } else if (price < ema147 && price < ema258 && price < ema369) {
        emaContext = '⚠️ Giá dưới cả 3 EMA → Xu hướng GIẢM mạnh';
    } else if (price > ema147) {
        emaContext = '📊 Giá trên EMA147 → Xu hướng ngắn hạn TĂNG';
    } else {
        emaContext = '📊 Giá dưới EMA147 → Xu hướng ngắn hạn GIẢM';
    }

    return `${emoji} <b>TÍN HIỆU XAU/USD — ${action}</b>

📌 <b>${sig.msg}</b>

💰 Giá hiện tại: <b>${sig.price}</b>
📦 Vùng bị phá: ${sig.zoneBottom} → ${sig.zoneTop}

📈 EMA 147: ${ema147.toFixed(2)}
📉 EMA 258: ${ema258.toFixed(2)}
📊 EMA 369: ${ema369.toFixed(2)}

${emaContext}

⏰ Khung: M5 | Nguồn: XAU/USDT Futures
🕐 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}

⚡ <i>Nhớ đặt Stoploss!</i>`;
}

// ============================================================
//  8. HÀM QUÉT CHÍNH (Main Scanner)
// ============================================================
async function runScan() {
    try {
        console.log(`\n[SCAN ${++scanCount}] ${new Date().toISOString()} — Đang quét...`);

        // 1. Kéo 500 nến M5
        const candles = await fetchCandles(500);
        console.log(`  → Lấy được ${candles.length} nến M5`);

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        // 2. Tính 3 đường EMA
        const ema147 = calcEMA(closes, 147);
        const ema258 = calcEMA(closes, 258);
        const ema369 = calcEMA(closes, 369);

        const currentEMA147 = ema147[ema147.length - 1];
        const currentEMA258 = ema258[ema258.length - 1];
        const currentEMA369 = ema369[ema369.length - 1];

        console.log(`  → EMA147: ${currentEMA147.toFixed(2)} | EMA258: ${currentEMA258.toFixed(2)} | EMA369: ${currentEMA369.toFixed(2)}`);

        // 3. Tìm Swing High/Low
        const swingHighs = findSwingHighs(highs, SWING_LENGTH);
        const swingLows = findSwingLows(lows, SWING_LENGTH);
        console.log(`  → Swing Highs: ${swingHighs.length} | Swing Lows: ${swingLows.length}`);

        // 4. Tính ATR
        const atr = calcATR(candles, 50);
        console.log(`  → ATR(50): ${atr.toFixed(2)}`);

        // 5. Xây vùng Supply/Demand
        const { supply, demand } = buildZones(candles, swingHighs, swingLows, atr);
        supplyZones = supply;
        demandZones = demand;
        console.log(`  → Supply Zones: ${supply.length} | Demand Zones: ${demand.length}`);

        // 6. Kiểm tra BOS
        const signals = detectBOS(candles, supply, demand);

        if (signals.length > 0) {
            console.log(`  🚨 PHÁT HIỆN ${signals.length} TÍN HIỆU BOS!`);
            for (const sig of signals) {
                const msg = formatSignalMessage(sig, currentEMA147, currentEMA258, currentEMA369);
                await sendTelegram(msg);
                console.log(`  → Đã gửi Telegram: ${sig.signal} @ ${sig.price}`);
            }
        } else {
            console.log(`  ✅ Không có tín hiệu BOS mới.`);
        }

        lastScanTime = new Date().toISOString();
        console.log(`  → Giá hiện tại: ${closes[closes.length - 1].toFixed(2)}`);

        // Dọn dẹp alertedBOS cũ (giữ 100 entry gần nhất)
        if (alertedBOS.size > 100) {
            const arr = Array.from(alertedBOS);
            alertedBOS = new Set(arr.slice(-50));
        }

    } catch (err) {
        console.error('[SCAN ERROR]', err.message);
    }
}

// ============================================================
//  9. EXPRESS SERVER (Keep-alive endpoint)
// ============================================================
app.get('/ping', (req, res) => {
    res.json({
        status: 'alive',
        bot: 'XAU Algo Bot',
        lastScan: lastScanTime,
        scanCount,
        supplyZones: supplyZones.length,
        demandZones: demandZones.length,
        uptime: Math.floor((Date.now() - STARTUP_TIME) / 1000) + 's'
    });
});

app.get('/', (req, res) => {
    res.send(`
        <h1>🏆 XAU Algo Bot — Đang Hoạt Động</h1>
        <p>Quét nến M5 mỗi 5 phút | Phát hiện BOS → Báo Telegram</p>
        <p>Lần quét cuối: ${lastScanTime || 'Chưa quét'}</p>
        <p>Tổng lần quét: ${scanCount}</p>
        <p>Supply Zones: ${supplyZones.length} | Demand Zones: ${demandZones.length}</p>
    `);
});

// ============================================================
//  10. KHỞI ĐỘNG
// ============================================================
app.listen(PORT, async () => {
    console.log(`\n🏆 XAU ALGO BOT — Server khởi động trên cổng ${PORT}`);
    console.log(`📊 Symbol: ${SYMBOL} | Interval: ${INTERVAL}`);
    console.log(`🔔 Telegram Bot: ${BOT_TOKEN ? 'Đã cấu hình' : '❌ THIẾU'}`);
    console.log(`📡 Chat ID: ${CHAT_ID ? 'Đã cấu hình' : '❌ THIẾU'}`);
    console.log(`⏰ Quét mỗi ${SCAN_INTERVAL_MS / 1000}s\n`);

    // Thông báo khởi động
    await sendTelegram(`🏆 <b>XAU Algo Bot Khởi Động</b>\n\n📊 Symbol: XAU/USDT Futures (≈ XAU/USD OANDA)\n⏰ Khung: M5\n🔄 Quét mỗi 5 phút\n🧠 Thuật toán: SMC + 4EMA\n\n<i>Bot sẽ tự động quét và báo tín hiệu BOS!</i>`);

    // Quét lần đầu sau 5 giây (grace period ngắn)
    setTimeout(() => {
        runScan();
        // Sau đó lặp lại mỗi 5 phút
        setInterval(runScan, SCAN_INTERVAL_MS);
    }, 5000);
});
