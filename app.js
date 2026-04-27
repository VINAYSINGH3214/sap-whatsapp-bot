const express = require('express');
const axios = require('axios');
const https = require('https');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// 🌐 serve files (IMPORTANT)
app.use(express.static(__dirname));

// ==============================
// 🔑 META CONFIG
// ==============================
const VERIFY_TOKEN = "mytoken123";
const ACCESS_TOKEN = "ACCESS_TOKEN";
const PHONE_NUMBER_ID = "PHONE_NUMBER_ID";

// 🔥 IMPORTANT: set your ngrok URL
const BASE_PUBLIC_URL = "NGROK_URL";

// ==============================
// 🔑 SAP CONFIG
// ==============================
const BASE_URL = "ODATA_URL";

const username = "SAP_USER";
const password = "SAP_PASS";

const authHeader = Buffer.from(`${username}:${password}`).toString('base64');

const agent = new https.Agent({
    rejectUnauthorized: false
});

// ==============================
// 🧠 STATE
// ==============================
const userState = {};
const lastMaterial = {};

// ==============================
// 🔧 FORMAT MATNR
// ==============================
function formatMatnr(matnrRaw) {
    if (/^\d+$/.test(matnrRaw)) {
        return matnrRaw.padStart(18, '0');
    }
    return matnrRaw;
}

// ==============================
// 📦 FETCH SAP
// ==============================
async function fetchMaterial(matnr) {
    const url =
`${BASE_URL}/MATERIAL_FULL_Set('${matnr}')?sap-client=200&$format=json`;

    const response = await axios.get(url, {
        httpsAgent: agent,
        headers: {
            'Authorization': `Basic ${authHeader}`,
            'Accept': 'application/json'
        }
    });

    return response.data.d;
}

// ==============================
// 📤 SEND TEXT
// ==============================
async function sendMessage(to, message) {
    await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: message }
        },
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`
            }
        }
    );
}

// ==============================
// 📄 CREATE PDF
// ==============================
async function createPDF(data, filename) {
    return new Promise((resolve) => {

        const doc = new PDFDocument();
        const stream = fs.createWriteStream(filename);

        doc.pipe(stream);

        doc.fontSize(20).text('Material Report', { align: 'center' });
        doc.moveDown();

        doc.fontSize(14).text(`Material: ${data.MATNR}`);
        doc.text(`Description: ${data.MAKTX}`);
        doc.text(`Type: ${data.MTART}`);
        doc.text(`Stock: ${data.LABST}`);

        doc.moveDown();
        doc.text(`Generated: ${new Date().toLocaleString()}`);

        doc.end();

        stream.on('finish', resolve);
    });
}

// ==============================
// 📤 SEND PDF
// ==============================
async function sendPDF(to, fileName) {

    const fileUrl = `${BASE_PUBLIC_URL}/${fileName}`;

    await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            to: to,
            type: "document",
            document: {
                link: fileUrl,
                filename: "Material_Report.pdf"
            }
        },
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`
            }
        }
    );
}

// ==============================
// 🔘 BUTTONS
// ==============================
async function sendButtonsContinue(to, matnr) {

    await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            to: to,
            type: "interactive",
            interactive: {
                type: "button",
                body: {
                    text: "Choose option 👇"
                },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: { id: `pdf_${matnr}`, title: "Download PDF" }
                        },
                        {
                            type: "reply",
                            reply: { id: "yes_next", title: "Another Material" }
                        },
                        {
                            type: "reply",
                            reply: { id: "no_stop", title: "Stop" }
                        }
                    ]
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`
            }
        }
    );
}

// ==============================
// 🔁 VERIFY
// ==============================
app.get('/webhook', (req, res) => {

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    res.sendStatus(403);
});

// ==============================
// 🚀 WEBHOOK
// ==============================
app.post('/webhook', async (req, res) => {

    try {

        const value = req.body.entry?.[0]?.changes?.[0]?.value;

        if (!value?.messages) return res.sendStatus(200);

        const message = value.messages[0];
        const fromUser = message.from;

        // 🔘 BUTTON HANDLER
        if (message.type === "interactive") {

            const id = message.interactive.button_reply.id;

            if (id.startsWith("pdf_")) {

                const matnrRaw = id.split("_")[1];
                const matnr = formatMatnr(matnrRaw);

                const data = await fetchMaterial(matnr);

                const fileName = `material_${matnrRaw}.pdf`;

                await createPDF(data, fileName);
                await sendPDF(fromUser, fileName);

                return res.sendStatus(200);
            }

            if (id === "yes_next") {
                userState[fromUser] = "WAITING_FOR_NEXT";
                await sendMessage(fromUser, "👉 Enter next material number");
            }

            if (id === "no_stop") {
                delete userState[fromUser];
                delete lastMaterial[fromUser];

                await sendMessage(fromUser,
`✅ Session ended

👉 Send material number anytime to start again`);
            }

            return res.sendStatus(200);
        }

        // 💬 TEXT HANDLER
        if (message.type === "text") {

            const text = message.text.body.trim();

            if (!text) return res.sendStatus(200);

            if (/\s/.test(text) || !/^[a-zA-Z0-9]+$/.test(text)) {
                await sendMessage(fromUser, "❌ Please send valid material number");
                return res.sendStatus(200);
            }

            const matnr = formatMatnr(text);
            const data = await fetchMaterial(matnr);

            if (!data || !data.MATNR) {
                await sendMessage(fromUser, "❌ Please pass valid material number");
                return res.sendStatus(200);
            }

            lastMaterial[fromUser] = { matnr: text, data };

            const reply =
`📦 Material: ${text}
📝 ${data.MAKTX}
🏷️ ${data.MTART}
📊 ${data.LABST}`;

            await sendMessage(fromUser, reply);
            await sendButtonsContinue(fromUser, text);
        }

    } catch (err) {
        console.log("ERROR:", err.message);
    }
    
    res.sendStatus(200);
});

// ==============================
// 🚀 START
// ==============================
app.listen(3000, () => {
    console.log("🚀 Bot running with PDF support");
});
