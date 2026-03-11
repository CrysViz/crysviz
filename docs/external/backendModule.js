<button onclick="connectBackend()">Enable Python Backend</button>
<div id="status">Backend: disconnected</div>

<script>
let socket = null;

function connectBackend() {
    try {
        // attempt connection to a local or remote backend
        socket = io("http://localhost:5000", {
            timeout: 1000,
            reconnection: false
        });

        socket.on("connect", () => {
            document.getElementById("status").textContent = 
                "Backend: connected";
        });

        socket.on("connect_error", () => {
            document.getElementById("status").textContent =
                "Backend: not found (running without backend)";
        });

        // Example streamed message
        socket.on("pos", (d) => {
            console.log("Received streamed update:", d);
            // Three.js handling here...
        });

    } catch (e) {
        document.getElementById("status").textContent =
            "Backend: error";
    }
}
</script>

