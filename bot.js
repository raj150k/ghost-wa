const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    normalizeMessageContent,
    makeCacheableSignalKeyStore,
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');

const { MongoClient } = require('mongodb');
const { randomBytes } = require('node:crypto');
const express = require('express');
const logger = require('pino')({ level: 'silent' });

// ================= Settings =================
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const EMERGENCY_CONTACT = '01984698728';
const FACEBOOK_URL = 'https://facebook.com/raj150k';
const TELEGRAM_URL = 'https://t.me/raj150k';

let PHONE = (process.env.PHONE || EMERGENCY_CONTACT).replace(/\D/g, '');
if (/^01\d{9}$/.test(PHONE)) PHONE = '88' + PHONE;

const IDLE_MS = 5 * 60_000;
const REPLY_WINDOW_MS = 30 * 60_000;
const MAX_REPLIES = 2;
const DELETE_AFTER_MS = 5 * 60_000;

// ================= State =================
let sock = null;
let connected = false;
let lastActive = 0;
let authCollection = null;
let retryTimer = null;

const replyLimits = new Map();
const botMessageIds = new Set();
const isOffline = () => Date.now() - lastActive >= IDLE_MS;

function errorText(error) {
    return String(error?.message || error || 'Unknown error')
        .replace(/mongodb(?:\+srv)?:\/\/[^\r\n]*/gi, '[MongoDB URI hidden]');
}

// ================= Render status page =================
const app = express();

app.get('/', (_, res) => {
    const connection = connected ? 'Connected ✅' : 'Not connected ❌';
    const mode = !connected
        ? 'Waiting for WhatsApp'
        : isOffline()
            ? 'OFFLINE 💤 (auto-reply ON)'
            : 'ONLINE 🟢 (auto-reply OFF)';

    res.set('Cache-Control', 'no-store').type('text/plain').send(
        `Ghost Hunter alive ✅\nWhatsApp: ${connection}\nMode: ${mode}\n`
    );
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Server started on port ${port}`);
});

// ================= MongoDB session =================
async function useMongoAuthState(collection) {
    const encode = value => JSON.stringify(value, BufferJSON.replacer);
    const decode = value => JSON.parse(value, BufferJSON.reviver);

    const saved = await collection.findOne({ _id: 'creds' });
    const creds = saved ? decode(saved.value) : initAuthCreds();

    // একই সেশনের লেখাগুলো ক্রমানুসারে হবে।
    let pending = Promise.resolve();

    function queue(work) {
        const job = pending.then(work);
        pending = job.catch(() => {});
        return job;
    }

    return {
        state: {
            creds,
            keys: {
                async get(type, ids) {
                    if (!ids.length) return {};
                    await pending;

                    const docs = await collection.find({
                        _id: { $in: ids.map(id => `${type}-${id}`) }
                    }).toArray();

                    const values = new Map(docs.map(doc => [doc._id, doc.value]));

                    return Object.fromEntries(ids.map(id => {
                        const stored = values.get(`${type}-${id}`);
                        let value = stored == null ? null : decode(stored);

                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }

                        return [id, value];
                    }));
                },

                set(updates) {
                    return queue(async () => {
                        const operations = [];

                        for (const [type, entries] of Object.entries(updates)) {
                            for (const [id, value] of Object.entries(entries)) {
                                const _id = `${type}-${id}`;

                                if (value == null) {
                                    operations.push({ deleteOne: { filter: { _id } } });
                                } else {
                                    operations.push({
                                        replaceOne: {
                                            filter: { _id },
                                            replacement: { _id, value: encode(value) },
                                            upsert: true
                                        }
                                    });
                                }
                            }
                        }

                        if (operations.length) {
                            await collection.bulkWrite(operations);
                        }
                    });
                }
            }
        },

        saveCreds: () => queue(() => collection.replaceOne(
            { _id: 'creds' },
            { _id: 'creds', value: encode(creds) },
            { upsert: true }
        )),

        flush: () => pending,

        // এই collection শুধু এই বটের WhatsApp সেশনের জন্য।
        clear: () => queue(() => collection.deleteMany({}))
    };
}

async function getAuth() {
    if (authCollection) return useMongoAuthState(authCollection);

    const client = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 15_000
    });

    try {
        await client.connect();
        const collection = client.db('ghostbot').collection('session');
        const auth = await useMongoAuthState(collection);

        // ডাটাবেসে পড়া সফল হওয়ার পরই collection মনে রাখবে।
        authCollection = collection;
        console.log('MongoDB connected ✅');
        return auth;
    } catch (error) {
        await client.close().catch(() => {});
        throw error;
    }
}

// ================= Message helpers =================
function rememberBotMessage(id) {
    if (!id || botMessageIds.has(id)) return;
    botMessageIds.add(id);
    setTimeout(() => botMessageIds.delete(id), IDLE_MS + 60_000).unref();
}

async function sendBotMessage(s, jid, content) {
    // পাঠানোর আগেই ID মনে রাখে, যাতে নিজের মেসেজকে activity না ধরে।
    const messageId = '3EB0' + randomBytes(9).toString('hex').toUpperCase();
    rememberBotMessage(messageId);

    const sent = await s.sendMessage(jid, content, { messageId });
    rememberBotMessage(sent?.key?.id);
    return sent;
}

async function setUnavailable(s) {
    if (sock !== s || !connected || !isOffline()) return;
    try {
        await s.sendPresenceUpdate('unavailable');
    } catch {}
}

function isUserMessage(message) {
    const content = normalizeMessageContent(message);

    if (!content || content.protocolMessage || content.reactionMessage) {
        return false;
    }

    return [
        'conversation', 'extendedTextMessage', 'imageMessage',
        'videoMessage', 'audioMessage', 'documentMessage',
        'stickerMessage', 'contactMessage', 'contactsArrayMessage',
        'locationMessage', 'liveLocationMessage',
        'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3'
    ].some(type => Boolean(content[type]));
}

function extractNumber(key) {
    for (const candidate of [key.remoteJid, key.remoteJidAlt, key.senderPn, key.participantPn]) {
        if (typeof candidate !== 'string') continue;
        const match = candidate.match(/^([1-9]\d{7,14})(?::\d+)?@s\.whatsapp\.net$/);
        if (match) return match[1];
    }
    return '';
}

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
📞 Emergency Contact : ${EMERGENCY_CONTACT}

✨ Thank you for messaging ✨`;

    let sent;

    try {
        const buttons = [
            ['📘 Facebook', FACEBOOK_URL],
            ['✈️ Telegram', TELEGRAM_URL]
        ].map(([label, url]) => ({
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text: label,
                url,
                merchant_url: url
            })
        }));

        sent = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                        header: { title: '', hasMediaAttachment: false },
                        body: { text },
                        footer: { text: '👇 Tap a button below 👇' },
                        nativeFlowMessage: { buttons }
                    })
                }
            }
        }, { userJid: s.user.id });

        rememberBotMessage(sent.key.id);

        await s.relayMessage(jid, sent.message, {
            messageId: sent.key.id,
            additionalNodes: [{
                tag: 'biz',
                attrs: {},
                content: [{
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{
                        tag: 'native_flow',
                        attrs: { v: '9', name: 'mixed' }
                    }]
                }]
            }]
        });
    } catch (error) {
        console.warn('Button send failed:', errorText(error));
        sent = await sendBotMessage(s, jid, {
            text: text + `\n\n━━━━━━━━━━━━━━\n📘 Facebook : ${FACEBOOK_URL}\n✈️ Telegram : ${TELEGRAM_URL}\n📞 Emergency : ${EMERGENCY_CONTACT}`
        });
    }

    await setUnavailable(s);
    return sent;
}

async function deleteBotReply(jid, key) {
    const s = sock;
    if (!s || !connected || !key?.id) return;

    try {
        await sendBotMessage(s, jid, { delete: key });
        await setUnavailable(s);
    } catch (error) {
        console.warn('Delete failed:', errorText(error));
    }
}

// ================= Incoming messages =================
async function handleMessages(s, { messages = [], type }) {
    for (const msg of messages) {
        if (sock !== s || !connected) return;
        if (!msg.key || !isUserMessage(msg.message)) continue;

        const key = msg.key;

        if (key.fromMe) {
            if (botMessageIds.has(key.id)) continue;

            // শুধু সাম্প্রতিক আসল মেসেজ activity হিসেবে গুনবে।
            const now = Date.now();
            const sentAt = Number(msg.messageTimestamp?.toString() || 0) * 1000;

            if (sentAt >= now - IDLE_MS && sentAt <= now + 10_000) {
                lastActive = Math.max(lastActive, Math.min(sentAt, now));
            }
            continue;
        }

        const jid = key.remoteJid;
        if (type !== 'notify' || typeof jid !== 'string') continue;
        if (!/@(?:s\.whatsapp\.net|lid)$/.test(jid) || !isOffline()) continue;

        const now = Date.now();
        let limit = replyLimits.get(jid);

        if (!limit || now - limit.since >= REPLY_WINDOW_MS) {
            limit = { since: now, count: 0 };
            replyLimits.set(jid, limit);
        }

        if (limit.count >= MAX_REPLIES) continue;

        // পাঠানোর আগেই স্লট রাখে, একসাথে মেসেজ এলেও সীমা ছাড়াবে না।
        limit.count++;

        try {
            const sent = await sendReplyWithButtons(
                s, jid, msg.pushName || 'Friend', extractNumber(key)
            );

            console.log(`Replied to private chat [${limit.count}/${MAX_REPLIES}]`);

            if (sent?.key?.id) {
                setTimeout(
                    () => void deleteBotReply(jid, sent.key),
                    DELETE_AFTER_MS
                ).unref();
            }
        } catch (error) {
            limit.count--;
            console.error('Reply failed:', errorText(error));
        }
    }
}

// ================= WhatsApp connection =================
function retryIn(ms) {
    if (retryTimer) return;

    retryTimer = setTimeout(() => {
        retryTimer = null;
        void start();
    }, ms);
}

async function start() {
    try {
        const auth = await getAuth();
        const { version } = await fetchLatestBaileysVersion();

        const s = makeWASocket({
            version,
            logger,
            auth: {
                creds: auth.state.creds,
                keys: makeCacheableSignalKeyStore(auth.state.keys, logger)
            },
            printQRInTerminal: false,
            emitOwnEvents: false,
            markOnlineOnConnect: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        sock = s;
        let pairingRequested = false;

        s.ev.on('creds.update', update => {
            if (sock !== s) return;
            Object.assign(auth.state.creds, update);

            void auth.saveCreds().catch(error => {
                console.error('Session save error:', errorText(error));
            });
        });

        s.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
            if (sock !== s) return;

            if (connection === 'close') {
                connected = false;
                sock = null;
                await auth.flush();

                const status = lastDisconnect?.error?.output?.statusCode;

                if (status === DisconnectReason.connectionReplaced) {
                    console.warn('Connection replaced — একই সেশন দিয়ে একটাই বট চালাও।');
                    return;
                }

                if (status === DisconnectReason.loggedOut) {
                    console.warn('WhatsApp logged out — নতুন করে লিংক করতে হবে।');

                    try {
                        await auth.clear();
                    } catch (error) {
                        console.error('Session reset error:', errorText(error));
                    }

                    retryIn(15_000);
                    return;
                }

                console.log(`Reconnecting... (${status ?? 'unknown'})`);
                retryIn(status === DisconnectReason.restartRequired ? 1_000 : 10_000);
                return;
            }

            if (connection === 'open') {
                connected = true;
                console.log('Ghost Hunter Running... ✅');
                await setUnavailable(s);
                return;
            }

            // WhatsApp pairing-এর জন্য প্রস্তুত হলেই কোড চায়।
            if (qr && !auth.state.creds.registered && !pairingRequested) {
                pairingRequested = true;

                try {
                    const code = await s.requestPairingCode(PHONE);
                    if (sock === s && !connected) console.log('PAIRING CODE:', code);
                } catch (error) {
                    pairingRequested = false;
                    console.error('Pairing error:', errorText(error));
                }
            }
        });

        s.ev.on('messages.upsert', update => {
            void handleMessages(s, update).catch(error => {
                console.error('Message handler error:', errorText(error));
            });
        });
    } catch (error) {
        console.error('Start error:', errorText(error));
        retryIn(15_000);
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [jid, limit] of replyLimits) {
        if (now - limit.since >= REPLY_WINDOW_MS) replyLimits.delete(jid);
    }
}, 60_000).unref();

if (!/^mongodb(?:\+srv)?:\/\//.test(MONGODB_URI) ||
    /<db_password>|<password>|PASSWORD_HERE/i.test(MONGODB_URI)) {
    console.error('Setup error: Render Environment-এ সঠিক MONGODB_URI বসাও।');
} else if (!/^[1-9]\d{7,14}$/.test(PHONE)) {
    console.error('Setup error: PHONE-এ কান্ট্রি কোডসহ WhatsApp নম্বর দাও, + ছাড়া।');
} else {
    void start();
                     }
