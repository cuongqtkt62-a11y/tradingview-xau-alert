// ============================================================
// TradingView XAU/USD Alert Webhook → Telegram
// Chạy 24/7 trên Render (Frankfurt EU)
// ============================================================

const express = require('express');
const app = express();

// Parse cả JSON lẫn plain text (TradingView gửi cả 2 dạng)
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ limit: '1mb' }));

// ===================== ENV =====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'xau-smc-2026';
const PORT = process.env.PORT || 10016;

// ===================== STARTUP CHECK =====================
if (!BOT_TOKEN) {
    console.error('❌ FATAL: Thiếu TELEGRAM_BOT_TOKEN trong .env');
    process.exit(1);
}
if (!CHAT_ID) {
    console.warn('⚠️ WARNING: TELEGRAM_CHAT_ID chưa được cấu hình! Alert sẽ không gửi được.');
}

// ===================== TELEGRAM SENDER =====================
async function sendTelegram(text) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.error('❌ Không gửi được: Thiếu BOT_TOKEN hoặc CHAT_ID');
        return null;
    }

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: CHAT_ID,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        })
    });

    const result = await response.json();
    if (!result.ok) {
        console.error('❌ Telegram API error:', result.description);
        throw new Error(`Telegram: ${result.description}`);
    }
    console.log('✅ Telegram message sent successfully');
    return result;
}

// ===================== FORMAT ALERT =====================
function formatAlert(data) {
    const signal = (data.signal || '').toUpperCase();
    const msgText = data.msg || data.message || '';

    // Detect Long/Short từ signal hoặc nội dung tin nhắn
    const isLong = signal === 'LONG'
        || msgText.includes('Long')
        || msgText.includes('BOS đỏ');

    const emoji = isLong ? '🟢' : '🔴';
    const direction = isLong ? 'LONG ▲' : 'SHORT ▼';
    const bosType = isLong ? 'SUPPLY (Vùng Cung)' : 'DEMAND (Vùng Cầu)';
    const action = isLong ? 'MUA' : 'BÁN';

    // Thời gian Việt Nam
    const now = new Date().toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    // Giá
    const price = data.price
        ? `$${parseFloat(data.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : 'N/A';

    // Khung thời gian
    const tf = data.tf || 'M5';

    // EMA Context (nếu Pine Script gửi kèm)
    let emaBlock = '';
    if (data.ema147 && data.ema258 && data.ema369) {
        const e147 = parseFloat(data.ema147).toFixed(2);
        const e258 = parseFloat(data.ema258).toFixed(2);
        const e369 = parseFloat(data.ema369).toFixed(2);

        // Xác định xu hướng EMA
        const isBullish = parseFloat(data.price) > parseFloat(data.ema147);
        const trendEmoji = isBullish ? '📗' : '📕';
        const trendText = isBullish ? 'Giá TRÊN kênh EMA → Uptrend' : 'Giá DƯỚI kênh EMA → Downtrend';

        emaBlock = `
📐 <b>EMA Context:</b>
   ├ EMA 147: $${e147}
   ├ EMA 258: $${e258}
   └ EMA 369: $${e369}
${trendEmoji} <i>${trendText}</i>`;
    }

    return `
${emoji}${emoji}${emoji} <b>${direction} XAU/USD</b> ${emoji}${emoji}${emoji}
━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 <b>BOS ${bosType} đã bị phá vỡ!</b>
💡 <b>Hành động:</b> Canh ${action}

📊 <b>Tín hiệu:</b> ${msgText || 'BOS Alert'}
💰 <b>Giá:</b> ${price}
⏰ <b>Thời gian:</b> ${now}
📈 <b>Khung:</b> ${tf}
${emaBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>NHỚ ĐẶT STOPLOSS NGAY!</b>
📏 <i>Kỷ luật R:R tối thiểu 1:2</i>
🧊 <i>"No Stop Hunt — No Trade"</i>
`.trim();
}

// ===================== ROUTES =====================

// 1. WEBHOOK CHÍNH — TradingView gửi tín hiệu tới đây
app.post('/webhook/tradingview', async (req, res) => {
    try {
        // Xác thực secret
        const secret = req.query.secret;
        if (secret !== WEBHOOK_SECRET) {
            console.log(`⛔ Webhook rejected: invalid secret (got: ${secret})`);
            return res.status(403).json({ error: 'Invalid secret' });
        }

        // Parse payload — TradingView có thể gửi JSON hoặc plain text
        let data;
        if (typeof req.body === 'string') {
            try {
                data = JSON.parse(req.body);
            } catch {
                // Plain text alert (chưa cập nhật Pine Script)
                data = { message: req.body };
            }
        } else if (typeof req.body === 'object' && req.body !== null) {
            data = req.body;
        } else {
            data = { message: 'Unknown alert' };
        }

        console.log('📥 Webhook received:', JSON.stringify(data));

        // Format và gửi Telegram
        const message = formatAlert(data);
        await sendTelegram(message);

        res.json({ ok: true, sent: true });

    } catch (err) {
        console.error('❌ Webhook processing error:', err.message);

        // Vẫn trả 200 để TradingView không retry liên tục
        res.status(200).json({ ok: false, error: err.message });
    }
});

// 2. HEALTH CHECK
app.get('/', (req, res) => {
    res.json({
        status: '🟢 Running',
        service: 'TradingView XAU Alert → Telegram',
        uptime: `${Math.floor(process.uptime())}s`,
        chatId: CHAT_ID ? '✅ Configured' : '❌ Missing',
        timestamp: new Date().toISOString()
    });
});

// 3. PING — Cho Cron Job keep-alive
app.get('/ping', (req, res) => {
    console.log(`🏓 Ping received at ${new Date().toISOString()}`);
    res.send('pong');
});

// 4. TEST ALERT — Gửi cảnh báo thử
app.get('/test-alert', async (req, res) => {
    try {
        const testData = {
            signal: 'LONG',
            msg: '🧪 TEST — Giá qua khỏi BOS đỏ, Long Nào',
            price: '3245.50',
            tf: 'M5',
            ema147: '3240.00',
            ema258: '3220.00',
            ema369: '3200.00'
        };

        const message = formatAlert(testData);
        await sendTelegram(message);
        res.json({ ok: true, message: 'Test alert đã gửi lên Telegram!' });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// 5. TEST SHORT ALERT
app.get('/test-short', async (req, res) => {
    try {
        const testData = {
            signal: 'SHORT',
            msg: '🧪 TEST — Giá qua khỏi BOS xanh, Short Nào',
            price: '3280.75',
            tf: 'M5',
            ema147: '3260.00',
            ema258: '3240.00',
            ema369: '3220.00'
        };

        const message = formatAlert(testData);
        await sendTelegram(message);
        res.json({ ok: true, message: 'Test SHORT alert đã gửi lên Telegram!' });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ===================== START SERVER =====================
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  🏆 TradingView XAU Alert Server Started!   ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Port: ${PORT}                                ║`);
    console.log(`║  Webhook: POST /webhook/tradingview          ║`);
    console.log(`║  Test:    GET  /test-alert                   ║`);
    console.log(`║  Health:  GET  /                             ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`📡 Webhook Secret: ${WEBHOOK_SECRET}`);
    console.log(`💬 Chat ID: ${CHAT_ID || '❌ CHƯA CẤU HÌNH'}`);
    console.log('');
});
