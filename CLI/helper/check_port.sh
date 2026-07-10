#!/bin/zsh

PORT="$1"

# Validate PORT is a number
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
    echo "Error: '$PORT' is not a valid port number." >&2
    exit 1
fi

# Check if server is already running
if lsof -i :$PORT >/dev/null; then
    echo "Server is already running on port $PORT."
    osascript -e 'tell application "iTerm" to activate'
    exit 0
fi

# Start the server
osascript -e 'tell application "iTerm"' \
         -e 'activate' \
         -e 'create window with profile "Default"' \
         -e 'tell current session of current window' \
         -e "write text \"cd /Users/flotr82/Software/CrysViz_hot_develop/docs && python3 -m http.server $PORT\"" \
         -e 'end tell' \
         -e 'end tell'

# Wait for the server to start (check every 0.5s for up to 5s)
for i in {1..10}; do
    if lsof -i :$PORT >/dev/null; then
        exit 0  # Success: server is running
    fi
    sleep 0.5
done

echo "Error: Server did not start on port $PORT after 5 seconds." >&2
exit 1
