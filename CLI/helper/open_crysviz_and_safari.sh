#!/bin/zsh

URL="$1"
PORT="$2"

# Un-minimize Safari
open -a Safari

# Switch to the tab (or open new tab if not found)
osascript <<END
tell application "Safari"
    delay 1
    set foundTab to false
    repeat with w in windows
        repeat with t in tabs of w
            try
                if (URL of t) contains "$URL" then
                    set foundTab to true
                    set current tab of w to t
                    exit repeat
                end if
            end try
        end repeat
        if foundTab then exit repeat
    end repeat
    if not foundTab then
        open location "$URL"
    end if
end tell
END
