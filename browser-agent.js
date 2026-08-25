// ======================================
//  BA HERMES BROWSER AGENT
// TOOL 1 ONLY - OPEN GUESTPRO
// ======================================


const express = require("express");
const { chromium } = require("playwright");


const app = express();

app.use(express.json());



// ======================================
// GLOBAL
// ======================================


let context = null;
let page = null;




// ======================================
// STATUS
// ======================================


app.get("/status",(req,res)=>{


res.json({

    status:"online",

    browser:
    context ? "opened" : "closed",

    page:
    page ? page.url() : "none"

});


});





// ======================================
// TOOL 1
// OPEN GUESTPRO POPUP
// ======================================


app.post("/open-browser",

async(req,res)=>{


try{


console.log(
"📩 OPEN BROWSER REQUEST"
);





// jika sudah terbuka

if(context){


return res.json({

status:"already opened",

url: page ? page.url() : ""

});


}






console.log(
"🚀 Membuka Chrome Popup..."
);







context =

await chromium.launchPersistentContext(

"./session",

{


// HARUS FALSE AGAR POPUP

headless:false,





executablePath:

"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",






viewport:null,





args:[


"--start-maximized",


"--disable-blink-features=AutomationControlled",


"--disable-infobars",


"--no-first-run",


"--no-default-browser-check"


]


}

);







// ambil tab pertama

page = context.pages()[0];



if(!page){


page = await context.newPage();


}







await page.goto(

"https://demo-dashboard-merchant.guestpro.co.id/user/login",

{

waitUntil:"domcontentloaded",

timeout:30000

}

);







await page.bringToFront();



await page.waitForTimeout(3000);







console.log(

"✅ GuestPro Login Popup Terbuka"

);







res.json({

status:"opened",

message:"Chrome GuestPro berhasil dibuka",

url:page.url()

});






}

catch(error){


console.log(

"❌ OPEN ERROR:",

error.message

);



res.status(500).json({

error:error.message

});


}



});











// ======================================
// ERROR HANDLER
// ======================================


process.on(

"uncaughtException",

(err)=>{


console.log(

"ERROR:",

err.message

);


});



process.on(

"unhandledRejection",

(err)=>{


console.log(

"REJECTION:",

err.message

);


});









// ======================================
// SERVER
// ======================================


const PORT = 5000;



app.listen(

PORT,

"0.0.0.0",

()=>{


console.log(

"🚀 Browser Agent aktif port 5000"

);


}

);



// tahan proses

process.stdin.resume();