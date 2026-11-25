const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');

// ================= Settings =================
let rawPhone = (process.env.PHONE || "8801984698728").replace(/[^0-9]/g, '');
if (rawPhone.startsWith('01') && rawPhone.length === 11) rawPhone = '88' + rawPhone;
const PHONE         = rawPhone;

const IDLE_MINUTES  = 5;   // এত মিনিট তুমি কিছু না লিখলে বট নিজে নিজে চালু হবে
const RESET_MINUTES = 30;   // ৩০ মিনিট পরে একই ব্যক্তির count reset
const MAX_REPLY     = 2;    // ৩০ মিনিটে একজনকে সর্বোচ্চ ২ বার greeting
const DELETE_AFTER  = 5;    // ৫ মিনিট পরে মেসেজ delete

// ================= State =================
let lastActive    = 0;      // শুরুতেই offline ধরা থাকবে → বট সাথে সাথে কাজ করা শুরু
let wasOffline    = true;
const users       = {};
const botSentIds  = new Set();
let sock = null;
let intervalStarted = false;

const isOffline = () => (Date.now() - lastActive) > IDLE_MINUTES * 60000;

// ================= Keep-alive (Render) =================
const app = express();
app.get('/', (_, res) => res.send(`Ghost Hunter alive ✅ | mode: ${isOffline() ? 'OFFLINE' : 'ONLINE'}`));
app.listen(process.env.PORT || 3000, () => console.log('Server started on port ' + (process.env.PORT || 3000)));

// ================= Helpers =================
function trackBotMsg(id) {
    if (!id) return;
    botSentIds.add(id);
    setTimeout(() => botSentIds.delete(id), 120000);
}

async function goInvisible(s) {
    try { if (s) await s.sendPresenceUpdate('unavailable'); } catch {}
}

async function sendSilent(s, jid, content, opts = {}) {
    const sent = await s.sendMessage(jid, content, opts);
    if (sent && sent.key && sent.key.id) trackBotMsg(sent.key.id);
    await goInvisible(s);
    return sent;
}

// ⭐ আসল নাম্বার বের করার চেষ্টা (LID হলে খালি থাকবে)
function extractNumber(msg, jid) {
    const jidUser = jid.split('@')[0];
    const isLid = jid.endsWith('@lid');
    const ctx = msg.message && msg.message.extendedTextMessage
        ? msg.message.extendedTextMessage.contextInfo : null;
    const candidates = [
        msg.key.participantAlt,
        msg.key.participantPn,
        msg.key.remoteJidAlt,
        ctx ? ctx.participant : null
    ].filter(c => typeof c === 'string' && c.length > 0);

    for (const c of candidates) {
        if (c.endsWith('@lid')) continue;
        const n = c.split('@')[0].split(':')[0];
        if (/^\d{8,15}$/.test(n)) return n;
    }
    if (!isLid && /^\d{8,15}$/.test(jidUser)) return jidUser;
    return '';
}

// ⭐ বাটনে চাপ পড়েছে কি না ধরা
function getButtonAction(msg, text) {
    const m = msg.message;
    const btn = m.buttonsResponseMessage;
    if (btn) {
        const id = btn.selectedButtonId || '';
        if (id === 'fb_link' || (btn.selectedDisplayText || '').includes('Facebook')) return 'fb';
        if (id === 'tg_link' || (btn.selectedDisplayText || '').includes('Telegram')) return 'tg';
    }
    const inter = m.interactiveResponseMessage;
    if (inter && inter.nativeFlowResponseMessage && inter.nativeFlowResponseMessage.paramsJson) {
        try {
            const p = JSON.parse(inter.nativeFlowResponseMessage.paramsJson);
            if (p.id === 'fb_link') return 'fb';
            if (p.id === 'tg_link') return 'tg';
        } catch {}
    }
    const t = (text || '').trim();
    if (t === '📘 Facebook') return 'fb';
    if (t === '✈️ Telegram') return 'tg';
    return null;
}

// বাটন সহ greeting — মেসেজ হুবহু তোমার দেওয়াটাই
async function sendReplyWithButtons(s, jid, name, number) {
    const numberLine = number ? `🌐 Number : +${number}\n\n` : '';
    const text = `Hey ${name} 🌸
    
${numberLine}Welcome to RA J Personal Assistant With Ghost Hunter 🤖

📩 Your message has been received successfully.

Boss is currently offline or busy 💤
But don't worry — your message has been forwarded successfully ✅

💬 As soon as Boss comes online, you'll get a reply.

⏳ Please wait patiently...

😎 My Boss : RA J 🤘
⚡ Assistant : Ghost Hunter
📞 Emergency Contact : 01984698728

✨ Thank you for messaging ✨`;

    try {
        const msgContent = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                        body: proto.Message.InteractiveMessage.Body.fromObject({ text: text }),
                        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "👇 Tap a button below 👇" }),
                        header: proto.Message.InteractiveMessage.Header.fromObject({
                            title: "",
                            hasMediaAttachment: false
                        }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                            buttons: [
                                {
                                    name: "quick_reply",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "📘 Facebook",
                                        id: "fb_link"
                                    })
                                },
                                {
                                    name: "quick_reply",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "✈️ Telegram",
                                        id: "tg_link"
                                    })
                                }
                            ]
                        })
                    })
                }
            }
        }, { userJid: s.user.id });

        trackBotMsg(msgContent.key.id);

        await s.relayMessage(jid, msgContent.message, {
            messageId: msgContent.key.id,
            additionalNodes: [
                {
                    tag: 'biz',
                    attrs: {},
                    content: [
                        {
                            tag: 'interactive',
                            attrs: { type: 'native_flow', v: '1' },
                            content: [
                                {
                                    tag: 'native_flow',
                                    attrs: { v: '9', name: 'mixed' }
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        await goInvisible(s);
        return msgContent;
    } catch (e) {
        console.log("Button failed, normal text pathacche:", e.message);
        const fallback = text + "\n\n━━━━━━━━━━━━━━\n📘 Facebook : https://facebook.com/raj150k\n✈️ Telegram : https://t.me/raj150k\n📞 Emergency : 01984698728";
        return await sendSilent(s, jid, { text: fallback });
    }
}

// ================= Main =================
async function start() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE);
                console.log("\n==============================");
                console.log("NUMBER:", PHONE);
                console.log("PAIRING CODE:", code);
                console.log("==============================\n");
            } catch (e) { console.log("Pairing error:", e.message); }
        }, 5000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            console.log("Ghost Hunter Running... ✅");
            await goInvisible(sock);
        }
        if (connection === 'close') {
            const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
                ? lastDisconnect.error.output.statusCode
                : null;
            if (code === DisconnectReason.loggedOut) {
                console.log("Logged out ❌ — session মুছে আবার pair করো।");
            } else {
                console.log("Reconnecting...");
                setTimeout(start, 3000);
            }
        }
    });

    if (!intervalStarted) {
        intervalStarted = true;
        setInterval(async () => {
            const off = isOffline();
            if (off !== wasOffline) {
                console.log(off ? "💤 Boss offline → auto-reply ON" : "🟢 Boss online → auto-reply OFF");
                wasOffline = off;
            }
            if (off && sock) await goInvisible(sock);
        }, 60000);
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            const jid  = msg.key.remoteJid;
            const text = msg.message.conversation
                      || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text)
                      || (msg.message.imageMessage && msg.message.imageMessage.caption)
                      || (msg.message.videoMessage && msg.message.videoMessage.caption)
                      || (msg.message.documentMessage && msg.message.documentMessage.caption)
                      || '';

            // ---------- তোমার নিজের মেসেজ: শুধু "online" হিসেবে গণ্য, কোনো command নেই ----------
            if (msg.key.fromMe) {
                if (botSentIds.has(msg.key.id)) { botSentIds.delete(msg.key.id); continue; }
                lastActive = Date.now();   // তুমি মেসেজ দিলেই বট থেমে যাবে
                continue;
            }

            // ---------- Incoming ----------
            if (!jid) continue;
            if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue;

            // ⭐ বাটনে চাপ দিলে — boss online থাকুক বা offline, লিংক পাঠাবেই
            const action = getButtonAction(msg, text);
            if (action) {
                const linkText = action === 'fb'
                    ? "📘 Facebook : https://facebook.com/raj150k"
                    : "✈️ Telegram : https://t.me/raj150k";
                try {
                    const sent = await sendSilent(sock, jid, { text: linkText }, { quoted: msg });
                    setTimeout(async () => {
                        try {
                            const del = await sock.sendMessage(jid, { delete: sent.key });
                            if (del && del.key && del.key.id) trackBotMsg(del.key.id);
                            await goInvisible(sock);
                        } catch {}
                    }, DELETE_AFTER * 60000);
                } catch (e) { console.log("Link send failed:", e.message); }
                continue;
            }

            // ⭐ বাকি সব: boss offline থাকলে greeting যাবে (সব অটোমেটিক, command লাগে না)
            if (!isOffline()) continue;

            const name   = msg.pushName || "Friend";
            const number = extractNumber(msg, jid);
            const now    = Date.now();

            if (!users[jid]) users[jid] = { count: 0, time: now };
            const data = users[jid];
            if (now - data.time > RESET_MINUTES * 60000) { data.count = 0; data.time = now; }
            if (data.count >= MAX_REPLY) continue;

            try {
                const sent = await sendReplyWithButtons(sock, jid, name, number);
                data.count++;
                console.log(`Replied to ${name}${number ? ` (+${number})` : ''} [${data.count}/${MAX_REPLY}]`);
                setTimeout(async () => {
                    try {
                        const del = await sock.sendMessage(jid, { delete: sent.key });
                        if (del && del.key && del.key.id) trackBotMsg(del.key.id);
                        await goInvisible(sock);
                    } catch {}
                }, DELETE_AFTER * 60000);
            } catch (e) { console.log("Reply failed:", e.message); }
        }
    });
}
start();
