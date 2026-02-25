// Trigger start and then poll status
async function run() {
    try {
        console.log("Triggering /api/start...");
        const startRes = await fetch("https://whats.domiraa.com/api/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: "966503501223" })
        });
        const startData = await startRes.json();
        console.log("Start response:", startData);

        // Wait 10 seconds for connection attempt
        console.log("Waiting 10 seconds...");
        await new Promise(r => setTimeout(r, 10000));

        console.log("Checking status...");
        const statusRes = await fetch("https://whats.domiraa.com/api/status?phone=966503501223");
        const statusData = await statusRes.json();
        console.log("Status response:", JSON.stringify(statusData, null, 2));
    } catch (e) {
        console.error("Error:", e);
    }
}
run();
