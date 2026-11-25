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

const IDLE_MINUTES  = 5;    // এত মিনিট তুমি কিছু না লিখলে বট নিজে নিজে চালু হবে
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
    setTimeout(() => botSentIds.delete(id), (DELETE_AFTER + 2) * 60000);
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

// ভেতরে ঢুকে থাকা মেসেজ unwrap করা (ephemeral/viewOnce wrapper)
function unwrapMessage(m) {
    if (!m) return m;
    if (m.ephemeralMessage && m.ephemeralMessage.message) return unwrapMessage(m.ephemeralMessage.message);
    if (m.viewOnceMessage && m.viewOnceMessage.message) return unwrapMessage(m.viewOnceMessage.message);
    if (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message) return unwrapMessage(m.documentWithCaptionMessage.message);
    return m;
}

// মেসেজের আসল সময় (পুরনো sync মেসেজ যেন online ধরা না হয়)
function msgTime(msg) {
    const mt = msg.messageTimestamp;
    let t = 0;
    if (mt) {
        if (typeof mt === 'number') t = mt;
        else if (typeof mt.toNumber === 'function') t = mt.toNumber();
        else t = Number(mt) || 0;
    }
    if (t > 1000000000000) return t;
    if (t > 1000000000) return t * 1000;
    return Date.now();
}

// ⭐ আসল নাম্বার বের করার চেষ্টা (LID হলে খালি থাকবে)
function extractNumber(m, msg, jid) {
    const jidUser = jid.split('@')[0];
    const isLid = jid.endsWith('@lid');
    const ctx = m.extendedTextMessage ? m.extendedTextMessage.contextInfo : null;
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
                                    name: "cta_url",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "📘 Facebook",
                                        url: "https://facebook.com/raj150k",
                                        merchant_url: "https://facebook.com/raj150k"
                                    })
                                },
                                {
                                    name: "cta_url",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "✈️ Telegram",
                                        url: "https://t.me/raj150k",
                                        merchant_url: "https://t.me/raj150k"
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
            const jid = msg.key.remoteJid;
            if (!jid) continue;

            // ভেতরের আসল মেসেজ বের করা
            const m = unwrapMessage(msg.message);

            const text = m.conversation
                      || (m.extendedTextMessage && m.extendedTextMessage.text)
                      || (m.imageMessage && m.imageMessage.caption)
                      || (m.videoMessage && m.videoMessage.caption)
                      || (m.documentMessage && m.documentMessage.caption)
                      || '';

            // ---------- তোমার নিজের মেসেজ ----------
            if (msg.key.fromMe) {

                // ⭐ delete/revoke/reaction — সবসময় ignore, কখনো online ধরা হবে না
                if (m.protocolMessage || m.reactionMessage) {
                    console.log("🗑 মেসেজ delete/reaction → Boss online ধরা হয়নি");
                    continue;
                }

                // বটের নিজের পাঠানো মেসেজ echo — ignore
                if (botSentIds.has(msg.key.id)) { botSentIds.delete(msg.key.id); continue; }

                // status/story বাদ
                if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

                // খালি/টেকনিক্যাল মেসেজ — ignore
                const hasContent = !!(m.conversation || m.extendedTextMessage ||
                    m.imageMessage || m.videoMessage ||
                    m.documentMessage || m.audioMessage ||
                    m.stickerMessage || m.contactMessage ||
                    m.locationMessage);
                if (!hasContent) continue;

                // শুধু সত্যিকারের এখনকার মেসেজ হলে বট থামবে
                const age = Date.now() - msgTime(msg);
                if (age < 3 * 60000) {
                    lastActive = Date.now();
                    console.log("⏸ Boss নিজে মেসেজ দিয়েছে → বট " + IDLE_MINUTES + " মিনিটের জন্য বন্ধ");
                }
                continue;
            }

            // ---------- Incoming ----------
            if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue;

            // অন্যের delete/reaction এও greeting যাবে না
            if (m.protocolMessage || m.reactionMessage) continue;

            // boss offline থাকলে greeting যাবে (সব অটোমেটিক)
            if (!isOffline()) continue;

            const name   = msg.pushName || "Friend";
            const number = extractNumber(m, msg, jid);
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
