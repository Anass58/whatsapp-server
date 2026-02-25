const io = require("socket.io-client");
const socket = io("https://whats.domiraa.com");
socket.on("connect", () => console.log("Connected"));
socket.on("qr_update", (data) => console.log("qr_update:", data));
socket.on("connection_status", (data) => console.log("connection_status:", data));
socket.on("new_message", (data) => console.log("new_message:", data));

setTimeout(() => {
    console.log("Triggering /api/start");
    fetch("https://whats.domiraa.com/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "966503501223" })
    }).then(r => r.json()).then(console.log).catch(console.error);
}, 2000);
