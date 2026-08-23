// ======================================
// HERMES BROWSER AGENT FINAL
// CHROME POPUP VISIBLE VERSION
// + QUEUE GLOBAL (FIX RACE CONDITION / TIMEOUT SAAT BEBERAPA
//   REQUEST MASUK HAMPIR BERSAMAAN)
// + FIX LOGIN TIDAK TERSIMPAN:
//   Folder session (./chrome-session) SEKARANG DIHAPUS setiap kali
//   /open-browser dipanggil, SEBELUM context baru dibuat. Jadi
//   setiap kali browser dibuka, Chrome selalu mulai dari kondisi
//   "belum login" dan user WAJIB login manual lagi lewat popup.
// ======================================
//
// PERUBAHAN DARI VERSI SEBELUMNYA:
// Semua request (baik dari /chat-message maupun /inputPromotion)
// berbagi SATU `page` (browser tab) yang sama. Kalau ada beberapa
// request HTTP masuk hampir bersamaan, Node/Express akan mulai
// mengeksekusi handler-nya secara interleaved (karena tiap `await`
// di dalam isiPromotion melepas kontrol ke event loop) - akibatnya
// beberapa proses isiPromotion() bisa "jalan bersamaan" di atas
// `page` yang sama dan saling menimpa (page.goto, klik elemen,
// dsb), yang berujung timeout.
//
// FIX: tambahkan antrian (queue) global `automationQueue`. Semua
// pemanggilan isiPromotion() SEKARANG WAJIB lewat runInQueue(),
// yang memastikan task baru baru mulai dieksekusi SETELAH task
// sebelumnya benar-benar selesai (resolve/reject) - walau request
// HTTP-nya sendiri masuk ke server dalam waktu yang berdekatan.
// ======================================

console.log("🔥 INDEX HERMES AKTIF");


const express = require("express");
const fs = require("fs");
const { chromium } = require("playwright");

const { isiPromotion } = require("./tools/isi");

const {
    handlePromotionMessage,
    createEmptySession
} = require("./tools/parser");


const app = express();

app.use(express.json());


// ======================================
// GLOBAL
// ======================================

let context = null;
let page = null;

const SESSION_DIR = "./chrome-session";

const sessionStore = new Map();


// ======================================
// QUEUE GLOBAL UNTUK isiPromotion()
// ======================================
// automationQueue selalu menyimpan Promise dari task TERAKHIR yang
// diantrikan. Task baru "menempel" di belakangnya lewat .then(),
// sehingga tidak akan mulai dieksekusi sebelum task sebelumnya
// selesai - baik itu berhasil (resolve) maupun gagal (reject).
//
// .catch(() => {}) di akhir dipakai supaya kalau satu task gagal,
// antriannya TIDAK ikut macet/rusak untuk task-task berikutnya.
// ======================================
let automationQueue = Promise.resolve();
let queueLength = 0;

function runInQueue(taskFn) {
    queueLength++;
    const myPosition = queueLength;

    console.log(`⏳ MASUK ANTRIAN (posisi ke-${myPosition}, sedang menunggu ${myPosition - 1} proses lain selesai)`);

    const result = automationQueue.then(
        async () => {
            console.log(`▶️ MULAI EKSEKUSI (posisi antrian ke-${myPosition})`);
            const res = await taskFn();
            console.log(`✅ SELESAI EKSEKUSI (posisi antrian ke-${myPosition})`);
            return res;
        },
        async () => {
            // task sebelumnya gagal, tetap lanjut jalankan task ini
            console.log(`▶️ MULAI EKSEKUSI (posisi antrian ke-${myPosition}, setelah task sebelumnya gagal)`);
            const res = await taskFn();
            console.log(`✅ SELESAI EKSEKUSI (posisi antrian ke-${myPosition})`);
            return res;
        }
    );

    // Jaga antrian tetap "sehat" walau task ini reject, sekaligus
    // kurangi counter setelah task selesai (berhasil atau gagal).
    automationQueue = result.then(
        () => { queueLength--; },
        () => { queueLength--; }
    );

    return result;
}


// ======================================
// HELPER: HAPUS FOLDER SESSION CHROME
// ======================================
// Dipanggil sebelum context baru dibuat, supaya cookie/localStorage/
// session token dari login sebelumnya tidak ikut kepakai lagi.
// ======================================
function clearChromeSession() {try {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        console.log("🗑️ SESSION LAMA DIHAPUS (" + SESSION_DIR + "), LOGIN HARUS ULANG");
    } catch (e) {
        console.log("⚠️ GAGAL HAPUS SESSION LAMA:", e.message);
    }
}


// ======================================
// ERROR HANDLER
// ======================================

process.on("uncaughtException",(err)=>{

    console.log(
        "❌ SYSTEM ERROR:",
        err.message
    );

});


process.on("unhandledRejection",(err)=>{

    console.log(
        "❌ PROMISE ERROR:",
        err
    );

});





// ======================================
// STATUS
// ======================================

app.get("/status",(req,res)=>{


res.json({

    status:"online",

    browser:
        context && page
        ? "opened"
        : "closed",


    url:
        page
        ? page.url()
        : "none",


    session:
        sessionStore.size,

    queueLength:
        queueLength

});


});





// ======================================
// OPEN BROWSER POPUP
// ======================================

app.post("/open-browser",async(req,res)=>{


try{


console.log(
"🚀 MEMBUKA CHROME POPUP"
);



// Jika sudah terbuka
if(
context &&
page &&
!page.isClosed()
){


await page.bringToFront();


return res.json({

status:"already_open",

message:
"Browser sudah aktif"

});


}




// 🔥 FIX LOGIN TIDAK TERSIMPAN:
// hapus folder session SEBELUM context baru dibuat, supaya
// browser selalu mulai dari kondisi belum login.
clearChromeSession();




context =

await chromium.launchPersistentContext(

SESSION_DIR,

{


headless:false,


channel:"chrome",


viewport:null,


args:[


"--start-maximized",

"--window-position=0,0",

"--disable-blink-features=AutomationControlled",

"--no-first-run",

"--no-default-browser-check"


]


}

);



page =
context.pages()[0];



if(!page){

page =
await context.newPage();

}





await page.goto(

"https://demo-dashboard-merchant.guestpro.co.id/user/login",

{

waitUntil:"domcontentloaded",

timeout:60000

}

);



await page.bringToFront();



console.log(
"✅ POPUP LOGIN TERBUKA"
);



res.json({

status:"success",

message:
"Popup login terbuka. Silakan login manual lalu ketik SUDAH."

});


}

catch(error){


console.log(
"OPEN ERROR:",
error.message
);



res.status(500).json({

status:"error",

message:error.message

});


}


});

// ======================================
// CHECK LOGIN
// ======================================

app.post("/check-login", async(req,res)=>{


try{


if(
!context ||
!page
){

return res.json({

status:"error",

loggedIn:false,

message:
"Browser belum aktif"

});

}



if(page.isClosed()){


return res.json({

status:"error",

loggedIn:false,

message:
"Browser sudah tertutup"

});


}



await page.waitForTimeout(1000);



const currentUrl =
page.url();



console.log(
"CURRENT URL:",
currentUrl
);




if(
currentUrl.includes("/user/login")
){


return res.json({

status:"waiting",

loggedIn:false,

message:
"Masih di halaman login"

});


}





return res.json({

status:"success",

loggedIn:true,

message:
"Login berhasil",

url:
currentUrl

});


}

catch(error){


console.log(
"CHECK LOGIN ERROR:",
error.message
);



res.status(500).json({

status:"error",

message:error.message

});


}


});







// ======================================
// CHAT MESSAGE
// ======================================

app.post("/chat-message",async(req,res)=>{


try{


const {

chatId,

text

}=req.body;



if(
!chatId ||
typeof text !== "string"

){


return res.status(400).json({

status:"error",

message:
"chatId dan text wajib"

});


}




console.log(
"💬 CHAT:",
chatId,
text
);




const result =

handlePromotionMessage(

sessionStore,

chatId,

text

);





// masih proses tanya jawab

if(
result.status !== "ready_to_execute"

){


return res.json({

status:
result.status,

message:
result.message

});


}





console.log(
"⚡ MENJALANKAN PROMOTION (chat-message, akan antri kalau ada proses lain jalan)"
);



if(
!context ||
!page

){


returnres.json({

status:"error",

message:
"Browser belum aktif. Jalankan open-browser dahulu."

});


}




// FIX: dibungkus runInQueue() supaya tidak jalan bersamaan
// dengan proses isiPromotion() lain (dari /inputPromotion atau
// /chat-message request lain) yang berbagi `page` yang sama.
const automationResult =

await runInQueue(
    () => isiPromotion(page, result.data)
);





return res.json({

status:
automationResult.status,


message:
automationResult.message,


detail:
automationResult


});



}

catch(error){


console.log(
"CHAT ERROR:",
error.message
);



res.status(500).json({

status:"error",

message:error.message

});


}



});






// ======================================
// RESET CHAT
// ======================================

app.post("/reset-chat",(req,res)=>{


try{


const {
chatId
}=req.body;



if(!chatId){


return res.status(400).json({

status:"error",

message:
"chatId wajib"

});


}




sessionStore.set(

chatId,

createEmptySession()

);



console.log(

"♻️ RESET SESSION:",

chatId

);




res.json({

status:"success",

message:
"Session berhasil direset"

});


}

catch(error){


res.status(500).json({

status:"error",

message:error.message

});


}


});

// ======================================
// INPUT PROMOTION DIRECT
// ======================================

app.post("/inputPromotion", async(req,res)=>{


try{


console.log(
"⚡ DIRECT INPUT PROMOTION (akan antri kalau ada proses lain jalan)"
);



if(
!context ||
!page

){


return res.status(400).json({

status:"error",

message:
"Browser belum aktif"

});


}



console.log(
"DATA PROMOTION:"
);


console.log(
req.body
);





// FIX: dibungkus runInQueue() - INI KUNCI UTAMA PERBAIKAN.
// Kalau 5 request /inputPromotion masuk hampir bersamaan (mis.
// dari proses Excel batch di sisi Hermes/WhatsApp bot), kelima
// task ini SEKARANG dijamin dieksekusi satu-per-satu secara
// berurutan di atas `page` yang sama - bukan interleaved/paralel
// seperti sebelumnya (yang menyebabkan timeout).
const result =

await runInQueue(
    () => isiPromotion(page, req.body)
);





res.json(result);



}

catch(error){


console.log(

"INPUT PROMOTION ERROR:",

error.message

);



res.status(500).json({

status:"error",

message:error.message

});


}


});







// ======================================
// CLOSE BROWSER
// ======================================

app.post("/close-browser", async(req,res)=>{


try{


console.log(
"🛑 MENUTUP BROWSER"
);



if(context){


await context.close();


}



context = null;

page = null;



// 🔥 FIX LOGIN TIDAK TERSIMPAN:
// hapus juga folder session saat browser ditutup, sebagai
// jaga-jaga kalau proses berikutnya tidak lewat /open-browser
// dulu (misalnya server di-restart paksa).
clearChromeSession();




res.json({

status:"closed",

message:
"Browser berhasil ditutup"

});



}

catch(error){


res.status(500).json({

status:"error",

message:error.message

});


}


});







// ======================================
// SERVER START
// ======================================

app.listen(

5000,

"0.0.0.0",

()=>{


console.log(
"🚀 HERMES BROWSER AGENT RUNNING"
);


console.log(
"🌐 PORT : 5000"
);


console.log(
"🖥️ CHROME POPUP MODE ACTIVE"
);


console.log(
"🧵 QUEUE MODE ACTIVE - isiPromotion() dijamin berjalan satu-per-satu"
);


console.log(
"🔒 SESSION MODE: LOGIN TIDAK TERSIMPAN (folder chrome-session dihapus tiap open/close browser)"
);


}

);