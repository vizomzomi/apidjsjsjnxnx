const express = require("express")
const multer = require("multer")
const cors = require("cors")
const fs = require("fs")
const axios = require("axios")
const { exec } = require("child_process")
const path = require("path")
const FormData = require("form-data")
const jwt = require("jsonwebtoken")

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
    console.error("[FATAL] JWT_SECRET belum diset di environment variables!")
    process.exit(1)
}


const API_USER = "1486660369";
const API_SECRET = "sWi95Xh3jNGWaKYXBsnBpLHXGZY2Jmcb";


async function detectNSFW(filePath) {
    try {
        const form = new FormData();
        form.append("media", fs.createReadStream(filePath));
        form.append("models", "nudity-2.1");
        form.append("api_user", API_USER);
        form.append("api_secret", API_SECRET);

        const { data } = await axios.post(
            "https://api.sightengine.com/1.0/check.json",
            form,
            {
                headers: form.getHeaders(),
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            }
        );

        if (data.status !== "success") {
            throw new Error("Sightengine API gagal merespons.");
        }

        const n = data.nudity || {};
        const sexualActivity = Number(n.sexual_activity || 0);
        const sexualDisplay = Number(n.sexual_display || 0);
        const erotica = Number(n.erotica || 0);
        const verySuggestive = Number(n.very_suggestive || 0);

        const blocked =
            sexualActivity >= 0.30 ||
            sexualDisplay >= 0.40 ||
            erotica >= 0.40 ||
            verySuggestive >= 0.90;

        return { blocked };
    } catch (err) {
        console.log("[NSFW CHECK ERROR]:", err.message);
        return { blocked: false }; 
    }
}

async function sendTelegram(text) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
            {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text
            },
            {
                timeout: 5000
            }
        )
    } catch (e) {
        console.log("[TELEGRAM ERROR]", e.message)
    }
}

const REPO_BLOCKED_IP = "xyron11/cekverif"
const FILE_BLOCKED_IP = "blocked-ips.json"

async function getBlockedIPsFromGithub() {
    try {
        const res = await axios.get(
            `https://api.github.com/repos/${REPO_BLOCKED_IP}/contents/${FILE_BLOCKED_IP}`,
            { headers: { Authorization: "token " + process.env.GITHUB_TOKEN, "Cache-Control": "no-cache" } }
        )
        const content = Buffer.from(res.data.content, "base64").toString("utf8")
        return { list: JSON.parse(content), sha: res.data.sha }
    } catch (err) {
        if (err.response && err.response.status === 404) return { list: [], sha: null }
        console.log("[GITHUB BLOCKED-IP READ ERROR]", err.message)
        return { list: [], sha: null }
    }
}

async function saveBlockedIPsToGithub(list, sha) {
    const content = Buffer.from(JSON.stringify(list, null, 2)).toString("base64")
    try {
        const res = await axios.put(
            `https://api.github.com/repos/${REPO_BLOCKED_IP}/contents/${FILE_BLOCKED_IP}`,
            { message: "update blocked-ips.json", content, sha: sha || undefined },
            { headers: { Authorization: "token " + process.env.GITHUB_TOKEN } }
        )
        return res.data.content.sha
    } catch (err) {
        console.log("[GITHUB BLOCKED-IP SAVE ERROR]", err.message)
        return sha
    }
}

const app = express()
app.set("trust proxy", true)

global.blockedIPs = new Set()
global.blockedIPsSha = null

;(async () => {
    const { list, sha } = await getBlockedIPsFromGithub()
    global.blockedIPs = new Set(list)
    global.blockedIPsSha = sha
    console.log("[BLOCKED IP LOADED]", list.length, "IP")
})()

function getClientIP(req) {
    const forwarded = req.headers["x-forwarded-for"]
    return forwarded ? forwarded.split(",")[0].trim() : req.ip
}

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "authorization"]
}))

app.options("*", cors())
app.use(express.json())

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("public")) fs.mkdirSync("public");

app.use("/video", express.static(path.join(__dirname, "public")))


const upload = multer({ 
    dest: "uploads/",
    limits: { fileSize: 250 * 1024 * 1024 } 
})

global.results = []
global.videoProgress = {}

const MAX_RESULTS_DISIMPAN = 50 
const TTL_VIDEO_PROGRESS_MS = 10 * 60 * 1000 

function bersihkanProgressLama(videoId, delay = TTL_VIDEO_PROGRESS_MS) {
    setTimeout(() => {
        delete global.videoProgress[videoId]
    }, delay)
} 

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY

app.post("/request-upload-token", async (req, res) => {
    const { turnstileToken } = req.body

    if (!turnstileToken) {
        return res.status(400).json({ status: false, error: "Verifikasi captcha diperlukan" })
    }

    try {
        const verify = await axios.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            new URLSearchParams({ secret: TURNSTILE_SECRET, response: turnstileToken })
        )

        if (!verify.data.success) {
            return res.status(403).json({ status: false, error: "Verifikasi captcha gagal, coba lagi." })
        }

        const token = jwt.sign({ purpose: "upload-video" }, JWT_SECRET, { expiresIn: "15m" })
        res.json({ status: true, token })
    } catch (err) {
        res.status(500).json({ status: false, error: "Gagal verifikasi captcha" })
    }
})

function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(403).json({ status: false, error: "Forbidden" })
    }
    const token = authHeader.split(" ")[1]
    try {
        jwt.verify(token, JWT_SECRET)
        next()
    } catch (err) {
        return res.status(403).json({ status: false, error: "Token tidak valid atau sudah kadaluarsa" })
    }
}

app.post("/block-ip", verifyAdminToken, async (req, res) => {
    const { ip } = req.body
    if (!ip) return res.json({ status: false, error: "IP kosong" })
    global.blockedIPs.add(ip)
    console.log("[BLOCK IP]", ip)
    global.blockedIPsSha = await saveBlockedIPsToGithub([...global.blockedIPs], global.blockedIPsSha)
    res.json({ status: true, message: `IP ${ip} berhasil diblokir` })
})

app.post("/unblock-ip", verifyAdminToken, async (req, res) => {
    const { ip } = req.body
    if (!ip) return res.json({ status: false, error: "IP kosong" })
    global.blockedIPs.delete(ip)
    console.log("[UNBLOCK IP]", ip)
    global.blockedIPsSha = await saveBlockedIPsToGithub([...global.blockedIPs], global.blockedIPsSha)
    res.json({ status: true, message: `IP ${ip} berhasil dibuka blokirnya` })
})

app.get("/check-ip", (req, res) => {
    const clientIP = getClientIP(req)
    res.json({ blocked: global.blockedIPs.has(clientIP) })
})

app.get("/", (req, res) => {
    res.send("API READY")
})


app.get("/api/progress", (req, res) => {
    res.set({
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Surrogate-Control": "no-store"
    });

    const id = req.query.id
    if (!id || !global.videoProgress[id]) {
        return res.json({ status: "error", progress: 0, message: "ID tidak ditemukan" })
    }
    
    const dataProgress = global.videoProgress[id];

    if (dataProgress.status === "selesai") {
        return res.json({
            status: "selesai", 
            progress: 100,
            message: dataProgress.message,
            url: dataProgress.url
        })
    }
    

    if (dataProgress.status === "antre") {
        return res.json({
            status: "proses", 
            progress: 25, 
            message: "Sedang menganalisis struktur video..."
        })
    }
    

    res.json({
        status: "proses", 
        progress: 75,
        message: "Sedang merender video ke kualitas HD..."
    })
})



app.get("/results", (req, res) => {

    console.log(
        "[RESULT GET]",
        global.results.map(v => v.nomor)
    );

    const data = global.results.splice(0, global.results.length);

    res.json(data);
});

//jsjsjzjjdjd
const waitingQueue = [];
let isProcessing = false;

async function prosesAntreanBerikutnya() {
    if (isProcessing || waitingQueue.length === 0) return;

    isProcessing = true;
    const tugas = waitingQueue.shift();

    try {
        global.videoProgress[tugas.videoId] = { 
            status: "proses", 
            message: "Memulai proses rendering FFmpeg..." 
        };
        await tugas.eksekusiFfmpeg();
    } catch (err) {
        console.error("[Antrean Error]", err);
    } finally {
        isProcessing = false;
        prosesAntreanBerikutnya();
    }
}

app.get("/debug", (req, res) => {
    res.json({
        isProcessing,
        waitingQueue: waitingQueue.length,
        progressCount: Object.keys(global.videoProgress).length,
        resultCount: global.results.length
    })
})
//=======
const dapatkanDurasiVideo = (filePath) => {


    return new Promise((resolve, reject) => {
        exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nocreval=1 "${filePath}"`, (err, stdout) => {
            if (err) return resolve(30);
            const durasi = parseFloat(stdout.trim());
            resolve(isNaN(durasi) ? 30 : durasi);
        });
    });
};

const dapatkanDimensiVideo = (filePath) => {
    return new Promise((resolve) => {
        exec(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
            (err, stdout) => {
                if (err) return resolve({ width: null, height: null });
                const [w, h] = stdout.trim().split(",").map(Number);
                resolve({
                    width: Number.isFinite(w) ? w : null,
                    height: Number.isFinite(h) ? h : null
                });
            }
        );
    });
};

function verifyUploadToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(403).json({ status: false, error: "Forbidden" })
    }

    const token = authHeader.split(" ")[1];

    try {
        jwt.verify(token, JWT_SECRET);
        next()
    } catch (err) {
        return res.status(403).json({ status: false, error: "Token tidak valid atau sudah kadaluarsa" })
    }
}

app.post("/upload", verifyUploadToken, upload.single("video"), async (req, res) => {
    const clientIP = getClientIP(req)

    if (global.blockedIPs.has(clientIP)) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
        return res.json({ status: false, error: "kamu telah diblokir oleh admin." })
    }

    const file = req.file
    const nomor = req.body.nomor

    try {
        if (!file) return res.json({ status: false, error: "File kosong" })
        if (!nomor) {
            fs.unlinkSync(file.path)
            return res.json({ status: false, error: "Nomor kosong" })
        }

        sendTelegram(`ðŸ“¥ *Upload Masuk*\n\nIP: ${clientIP}\nNomor: ${nomor}\nFile: ${file.originalname}`)

const github = await axios.get(
  "https://api.github.com/repos/xyron11/cekverif/contents/verify.json",
  {
    headers: {
      Authorization: "token " + process.env.GITHUB_TOKEN,
      "Cache-Control": "no-cache"
    }
  }
)

const content = Buffer.from(
  github.data.content,
  "base64"
).toString("utf8")

const members = JSON.parse(content)

if (!members.includes(nomor)) {

    try {

        const realtime = await axios.get(
            "https://raw.githubusercontent.com/xyron11/cekverif/main/verify.json?nocache=" + Date.now(),
            {
                headers: {
                    "Cache-Control": "no-cache"
                },
                timeout: 5000
            }
        )

        const realtimeMembers = realtime.data || []

        if (!realtimeMembers.includes(nomor)) {

            fs.unlinkSync(file.path)

            return res.json({
                status: false,
                error: "Nomor tidak ada di grup mohon nomor yang anda pakai harus masuk group dulu, bisa anda pencet tombol join group untuk masuk ke group",
                join: "https://chat.whatsapp.com/BVtogIjS1hAD0qOMhJ3f6a"
            })

        }

    } catch {

        fs.unlinkSync(file.path)

        return res.json({
            status: false,
            error: "Nomor tidak ada di grup mohon nomor yang anda pakai harus masuk group dulu, bisa anda pencet tombol join group untuk masuk ke group",
            join: "https://chat.whatsapp.com/BVtogIjS1hAD0qOMhJ3f6a"
        })

    }
}

        const ext = file.originalname.split(".").pop().toLowerCase()
        const allow = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "jpg", "jpeg", "png"]

        if (!allow.includes(ext)) {
            fs.unlinkSync(file.path)
            return res.json({ status: false, error: "Hanya file video atau foto (JPG/PNG)" })
        }

        const isImage = ["jpg", "jpeg", "png"].includes(ext);

        if (isImage) {
            const nsfwCheck = await detectNSFW(file.path);
            if (nsfwCheck.blocked) {
                fs.unlinkSync(file.path); 
                sendTelegram(`ðŸš« *Deteksi Konten NSFW Ditolak!*\n\nIP: ${clientIP}\nNomor: ${nomor}\nNama File: ${file.originalname}\nStatus: Terdeteksi foto tidak senonoh.`);
                
                return res.json({
                    status: false,
                    error: "Foto ditolak! Sistem mendeteksi adanya konten pornografi atau tidak pantas."
                });
            }
        }


        const outputFilename = `${Date.now()}_HD_DanzClean.${isImage ? ext : 'mp4'}`

        const normalized = path.join(__dirname, "public", outputFilename)
        
        const durasiVideo = await dapatkanDurasiVideo(file.path);
        
        let bitrateIdeal = Math.floor(113246208 / durasiVideo);
if (bitrateIdeal > 4000000) bitrateIdeal = 4000000;
if (bitrateIdeal < 1200000) bitrateIdeal = 1200000;


        
        const targetBitrateKbps = `${Math.floor(bitrateIdeal / 1000)}k`;

        console.log(`[DanzClean] Memproses video dengan target bitrate: ${targetBitrateKbps}`);
const fpsVideo = await new Promise((resolve) => {

    exec(
        `ffprobe -v 0 -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "${file.path}"`,
        (err, stdout) => {

            if (err) return resolve(30)

            const rate = stdout.trim().split("/")

            if (rate.length === 2) {

                resolve(
                    Math.round(
                        Number(rate[0]) / Number(rate[1])
                    )
                )

            } else {
                resolve(30)
            }

        }
    )

})

const targetFps =
    fpsVideo > 60
        ? fpsVideo
        : 60



        let perintahFfmpeg = "";

                if (isImage) {
    perintahFfmpeg = `ffmpeg \
-i "${file.path}" \
-vf "scale='if(gte(iw,ih),-2,2160)':'if(gte(iw,ih),2160,-2)',unsharp=7:7:1.2:7:7:1.2,eq=contrast=1.06:saturation=1.15:brightness=0.01" \
-q:v 1 \
"${normalized}"`;
} else {
    
perintahFfmpeg = `ffmpeg \
-err_detect ignore_err \
-fflags +discardcorrupt \
-analyzeduration 100M \
-probesize 100M \
-i "${file.path}" \
-vf "scale='if(gte(iw,ih),-2,720)':'if(gte(iw,ih),720,-2)',unsharp=3:3:0.4:3:3:0.4" \
-r ${targetFps} \
-c:v libx264 \
-preset superfast \
-crf 15 \
-aq-mode 3 \
-colorspace bt709 \
-color_trc bt709 \
-color_primaries bt709 \
-maxrate 12M \
-bufsize 12M \
-pix_fmt yuv420p \
-threads 2 \
-c:a aac \
-b:a 128k \
-movflags +faststart \
"${normalized}"`
}

        const videoId = `vid_${Date.now()}`

        global.videoProgress[videoId] = { 
            status: "antre", 
            message: "Sedang mengompres video jadi HD..." 
        };

        res.json({
            status: true,
            id: videoId,
            message: "Video diterima server Railway! Memulai render..."
        });


                
        const eksekusiFfmpeg = () => {
            return new Promise((resolve) => {
                const prosesFfmpeg = exec(
                    perintahFfmpeg,
                    { maxBuffer: 30 * 1024 * 1024 }, 
                    async (err, stdout, stderr) => {
                        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

                        const sukses = fs.existsSync(normalized) && fs.statSync(normalized).size > 500 * 1024;

                        if (err && !sukses) {
                            const errorText = String(stderr || err.message || err);
                            global.videoProgress[videoId] = {
                                status: "error",
                                message: "Video tidak dapat diproses oleh server."
                            };
                            bersihkanProgressLama(videoId);

                            sendTelegram(`âŒ DanzClean Error\n\nNomor: ${nomor}\nFile: ${file.originalname}\nError:\n${errorText.slice(-1000)}`);
                            return resolve();
                        }

                        const { width, height } = await dapatkanDimensiVideo(normalized);

                        console.log(`[DIMENSI HASIL HD] nomor=${nomor} width=${width} height=${height} file=${outputFilename}`);

                        const domainPenyedia = req.get("host");
                        const protocolPenyedia = req.protocol;
                        const resultUrl = `${protocolPenyedia}://${domainPenyedia}/video/${outputFilename}`;

                        global.videoProgress[videoId] = { status: "selesai", message: "Video HD Matang!", url: resultUrl };
                        bersihkanProgressLama(videoId);

                        global.results.push({
                            url: resultUrl,
                            nomor: nomor,
                            time: Date.now(),
                            width,
                            height
                        });
                        if (global.results.length > MAX_RESULTS_DISIMPAN) {
                            global.results.splice(0, global.results.length - MAX_RESULTS_DISIMPAN)
                        }

                        setTimeout(() => {
                            if (fs.existsSync(normalized)) fs.unlink(normalized, () => {});
                        }, 5 * 60 * 1000);

                        resolve();
                    }
                );

                setTimeout(() => {
                    if (prosesFfmpeg && !prosesFfmpeg.killed && global.videoProgress[videoId]?.status === "proses") {
                        prosesFfmpeg.kill('SIGKILL');
                        global.videoProgress[videoId] = {
                            status: "error",
                            message: "Timeout, proses dihentikan paksa."
                        };
                        bersihkanProgressLama(videoId);
                        resolve();
                    }
                }, 5 * 60 * 1000);
            });
        };

        waitingQueue.push({ videoId, eksekusiFfmpeg });
        prosesAntreanBerikutnya();


    } catch (e) {
        
        console.log("[DanzClean Catch Error]:", e.message);
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        
        if (!res.headersSent) {
            res.json({
                status: false,
                error: "Gagal memproses HD video: " + e.message
            });
        }
    
        
        console.log("[DanzClean Catch Error]:", e.message)
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path)
        

        if (!res.headersSent) {
            res.json({
                status: false,
                error: "Gagal memproses HD video: " + e.message
            })
        }
    }
})

app.use((err, req, res, next) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
        return res.json({
            status: false,
            error: "Ukuran file terlalu besar! Maksimal ukuran yang diizinkan adalah 250 MB."
        })
    }
    res.status(500).json({ status: false, error: "Internal Server Error" })
})

app.listen(process.env.PORT || 3000, () => {
    console.log("API READY")
})
