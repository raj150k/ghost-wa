const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    proto,
    initAuthCreds,
    BufferJSON,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const { MongoClient } = require('mongodb');

// ================= Settings =================
let rawPhone = (process.env.PHONE || "8801984698728").replace(/[^0-9]/g, '');
if (rawPhone.startsWith('01') && rawPhone.length === 11) rawPhone = '88' + rawPhone;
const PHONE         = rawPhone;
const MONGODB_URI   = process.env.MONGODB_URI || "";

const FACEBOOK_URL  = "https://facebook.com/raj150k";
const TELEGRAM_URL  = "https://t.me/raj150k";

const IDLE_MINUTES  = 5;    // এত মিনিট তুমি কিছু না করলে বট নিজে চালু হবে
const RESET_MINUTES = 30;   // ৩০ মিনিট পরে একই ব্যক্তির count reset
const MAX_REPLY     = 2;    // ৩০ মিনিটে একজনকে সর্বোচ্চ ২ বার greeting
const DELETE_AFTER  = 5;    // ৫ মিনিট পরে মেসেজ delete

// ================= State =================
let lastActive    = 0;
let wasOffline    = true;
let botBusyUntil  = 0;
let isConnected   = false;
let pairingCode   = null;
const users       = {};
const botSentIds  = new Set();
let sock = null;
let intervalStarted = false;
let mongoClient = null;
let authCollection = null;

const isOffline = () => (Date.now() - lastActive) > IDLE_MINUTES * 60000;

// ডিলিট/ব্যাকগ্রাউন্ড মেসেজ — তোমার আসল মেসেজ না
const IGNORE_KEYS = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
function isRealUserMessage(message) {
    if (!message) return false;
    return Object.keys(message).some(k => !IGNORE_KEYS.includes(k));
}

// ================= Website (Status + Pairing Code) =================
const app = express();
app.get('/', (_, res) => {
    res.send(`<meta name="viewport" content="width=device-width,initial-scale=1">
        <div style="font-family:sans-serif;text-align:center;padding:20px">
        <h2>Ghost Hunter alive ✅</h2>
        <p>WhatsApp: ${isConnected ? 'Connected ✅' : 'Not connected ❌'}</p>
        ${(!isConnected && pairingCode) ? `<h1 style="letter-spacing:4px">${pairingCode}</h1><p>WhatsApp > Linked Devices > Link with phone number</p>` : ''}
        <p>Mode: ${isOffline() ? 'OFFLINE 💤 (auto-reply ON)' : 'ONLINE 🟢 (auto-reply OFF)'}</p>
        </div>`);
});
app.listen(process.env.PORT || 3000, () => console.log('Server started on port ' + (process.env.PORT || 3000)));

// ================= MongoDB Session (রিস্টার্টেও লগইন থাকবে) =================
async function useMongoAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne(
        { _id: id },
        { _id: id, value: JSON.stringify(data, BufferJSON.replacer) },
        { upsert: true }
    );
    const readData = async (id) => {
        const doc = await collection.findOne({ _id: id });
        return doc ? JSON.parse(doc.value, BufferJSON.reviver) : null;
    };
    const removeData = (id) => collection.deleteOne({ _id: id });

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds'),
        clear: () => collection.deleteMany({})
    };
}

async function getAuth() {
    if (MONGODB_URI) {
        if (!mongoClient) {
            mongoClient = new MongoClient(MONGODB_URI);
            await mongoClient.connect();
            authCollection = mongoClient.db('ghostbot').collection('session');
            console.log("MongoDB connected ✅ (session safe)");
        }
        return useMongoAuthState(authCollection);
    }
    console.log("⚠️ MONGODB_URI নেই — Render restart হলে আবার pair করতে হবে");
    const s = await useMultiFileAuthState('session');
    return { ...s, clear: async () => fs.rmSync('session', { recursive: true, force: true }) };
}

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
    botBusyUntil = Date.now() + 10000;
    const sent = await s.sendMessage(jid, content, opts);
    if (sent && sent.key && sent.key.id) trackBotMsg(sent.key.id);
    await goInvisible(s);
    return sent;
}

async function deleteBotMsg(s, jid, key) {
    try {
        botBusyUntil = Date.now() + 10000;
        const del = await s.sendMessage(jid, { delete: key });
        if (del && del.key && del.key.id) trackBotMsg(del.key.id);
        await goInvisible(s);
    } catch {}
}

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

😎 My Boss : RA J 
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
                                        url: FACEBOOK_URL,
                                        merchant_url: FACEBOOK_URL
                                    })
                                },
                                {
                                    name: "cta_url",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "✈️ Telegram",
                                        url: TELEGRAM_URL,
                                        merchant_url: TELEGRAM_URL
                                    })
                                }
                            ]
                        })
                    })
                }
            }
        }, { userJid: s.user.id });

        trackBotMsg(msgContent.key.id);
        botBusyUntil = Date.now() + 10000;

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
                            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
                        }
                    ]
                }
            ]
        });

        await goInvisible(s);
        return msgContent;
    } catch (e) {
        console.log("Button failed, normal text pathacche:", e.message);
        const fallback = text + `\n\n━━━━━━━━━━━━━━\n📘 Facebook : ${FACEBOOK_URL}\n✈️ Telegram : ${TELEGRAM_URL}\n📞 Emergency : 01984698728`;
        return await sendSilent(s, jid, { text: fallback });
    }
}

// ================= Main =================
async function start() {
    try {
        const { state, saveCreds, clear } = await getAuth();
        const { version } = await fetchLatestBaileysVersion();
        const logger = pino({ level: 'silent' });

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        if (!sock.authState.creds.registered) {
            const thisSock = sock;
            setTimeout(async () => {
                try {
                    if (thisSock !== sock) return;
                    const code = await thisSock.requestPairingCode(PHONE);
                    pairingCode = (code.match(/.{1,4}/g) || [code]).join('-');
                    console.log("\n==============================");
                    console.log("NUMBER:", PHONE);
                    console.log("PAIRING CODE:", pairingCode);
                    console.log("Website-e dekhabe: https://ghost-wa.onrender.com");
                    console.log("==============================\n");
                } catch (e) { console.log("Pairing error:", e.message); }
            }, 5000);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            if (connection === 'open') {
                isConnected = true;
                pairingCode = null;
                console.log("Ghost Hunter Running... ✅");
                await goInvisible(sock);
            }
            if (connection === 'close') {
                isConnected = false;
                const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
                    ? lastDisconnect.error.output.statusCode
                    : null;
                if (code === DisconnectReason.loggedOut) {
                    console.log("Logged out ❌ — নতুন pairing code আনা হচ্ছে...");
                    try { await clear(); } catch {}
                    setTimeout(start, 5000);
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
                if (off && sock && isConnected) await goInvisible(sock);
            }, 60000);
        }

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message) continue;
                const jid = msg.key.remoteJid;

                // তোমার নিজের আসল মেসেজ = online
                if (msg.key.fromMe) {
                    if (botSentIds.has(msg.key.id)) { botSentIds.delete(msg.key.id); continue; }
                    if (Date.now() < botBusyUntil) continue;
                    if (!isRealUserMessage(msg.message)) continue;
                    lastActive = Date.now();
                    continue;
                }

                // Incoming
                if (!jid) continue;
                if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue;
                if (!isRealUserMessage(msg.message)) continue;
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
                    setTimeout(() => deleteBotMsg(sock, jid, sent.key), DELETE_AFTER * 60000);
                } catch (e) { console.log("Reply failed:", e.message); }
            }
        });
    } catch (e) {
        console.log("Start error:", e.message, "— 10 sec por abar try...");
        setTimeout(start, 10000);
    }
}
start();
