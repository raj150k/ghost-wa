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
// তোমার নাম্বার 01984698728 কান্ট্রি কোড (88) সহ বসানো হয়েছে
let rawPhone = (process.env.PHONE || "8801984698728").replace(/[^0-9]/g, '');
if (rawPhone.startsWith('01') && rawPhone.length === 11) rawPhone = '88' + rawPhone;
const PHONE         = rawPhone;

const IDLE_MINUTES  = 10;   // ১০ মিনিট তুমি কিছু না লিখলে = Offline
const RESET_MINUTES = 30;   // ৩০ মিনিট পরে count reset
const MAX_REPLY     = 2;    // ৩০ মিনিটে সর্বোচ্চ ২ বার reply
const DELETE_AFTER  = 5;    // ৫ মিনিট পরে reply delete

// ================= State =================
let manualOffline = null;
let lastActive    = 0;      // শুরু থেকেই Offline মোডে থাকবে
let wasOffline    = true;
const users       = {};
const botSentIds  = new Set();
let sock = null;
let intervalStarted = false;

const isOffline = () => manualOffline !== null
    ? manualOffline
    : (Date.now() - lastActive) > IDLE_MINUTES * 60000;

// ================= Keep-alive (Render) =================
const app = express();
app.get('/', (_, res) => res.send(`Ghost Hunter alive ✅ | mode: ${isOffline() ? 'OFFLINE' : 'ONLINE'}`));
app.listen(process.env.PORT || 3000, () => console.log('Server started on port ' + (process.env.PORT || 3000)));

// ================= Helpers =================
function trackBotMsg(id) {
    if (!id) return;
    botSentIds.add(id);
    setTimeout(() => botSentIds.delete(id), 60000);
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

// বাটন সহ reply — তোমার আসল মেসেজ একদম আগের মতোই রাখা হয়েছে
async function sendReplyWithButtons(s, jid, name, number) {
    const text = `Hey ${name} 🌸
📱 Number : +${number}

Welcome to RA J Personal Assistant With Ghost Hunter 🤖

📩 Your message has been received successfully.

Boss is currently offline or busy 💤
But don't worry — your message has been forwarded successfully ✅

💬 As soon as Boss comes online, you'll get a reply.

⏳ Please wait patiently...

😎 My Boss : RA J 🤘
👑 Owner : @raj150k
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
                                    name: "cta_copy",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "📞 Copy Number",
                                        id: "copy_number",
                                        copy_code: "01984698728"
                                    })
                                },
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
        browser: ['Ubuntu', 'Chrome', '20.0.04'] // Pairing code ১০০% কাজ করার জন্য দরকারি
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

            // ---------- তোমার নিজের মেসেজ / Commands ----------
            if (msg.key.fromMe) {
                if (botSentIds.has(msg.key.id)) { botSentIds.delete(msg.key.id); continue; }
                lastActive = Date.now();
                const t = text.trim().toLowerCase();

                if (t === '!offline') { manualOffline = true;  await sendSilent(sock, jid, { text: "🔴 Offline mode ON" }); }
                else if (t === '!online') { manualOffline = false; await sendSilent(sock, jid, { text: "🟢 Online mode ON" }); }
                else if (t === '!auto') { manualOffline = null; await sendSilent(sock, jid, { text: "⚙️ Auto mode ON" }); }
                else if (t === '!status') {
                    const mode = manualOffline === null ? 'AUTO' : manualOffline ? 'MANUAL OFFLINE' : 'MANUAL ONLINE';
                    const idle = lastActive === 0 ? IDLE_MINUTES : Math.floor((Date.now() - lastActive) / 60000);
                    await sendSilent(sock, jid, { text: `📊 Mode: ${mode}\n⏱ Idle: ${idle} min\n🤖 Auto-reply: ${isOffline() ? 'ON' : 'OFF'}` });
                }
                else if (t === '!help') {
                    await sendSilent(sock, jid, { text: "🤖 Ghost Hunter Commands\n\n!offline - জোর করে Offline\n!online - জোর করে Online\n!auto - Auto Mode (10 min চুপ = Offline)\n!status - এখন কোন Mode এ আছে\n!help - এই লিস্ট" });
                }
                continue;
            }

            // ---------- Incoming ----------
            if (!jid) continue;
            if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue;
            if (!isOffline()) continue;

            const name   = msg.pushName || "Friend";
            const number = jid.split('@')[0];
            const now    = Date.now();

            if (!users[jid]) users[jid] = { count: 0, time: now };
            const data = users[jid];
            if (now - data.time > RESET_MINUTES * 60000) { data.count = 0; data.time = now; }
            if (data.count >= MAX_REPLY) continue;

            try {
                const sent = await sendReplyWithButtons(sock, jid, name, number);
                data.count++;
                console.log(`Replied to ${name} (+${number}) [${data.count}/${MAX_REPLY}]`);
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
