-- Run by terminal-notifier -execute through osascript: argv = {port, agentId[, accountId]}. Values are never spliced into
-- this text (the JS side validates them: 8 hex, account id [a-z0-9-]).
-- Reuse the open Safari deck tab (only its hash changes, so the page does not reload; the page switches account if the
-- link names another one, then selects the agent), else open the deep link in the default browser. Any failure
-- (e.g. Automation permission denied) also falls back. Link: #<agentId> or #<accountId>:<agentId> (web/hash.js).
on run argv
	set thePort to item 1 of argv
	set theId to item 2 of argv
	if (count of argv) > 2 then set theId to (item 3 of argv) & ":" & theId
	set deepLink to "http://127.0.0.1:" & thePort & "/#" & theId
	set prefixA to "http://127.0.0.1:" & thePort
	set prefixB to "http://localhost:" & thePort
	try
		if application "Safari" is running then
			tell application "Safari"
				repeat with w in windows
					repeat with t in tabs of w
						set u to URL of t
						if u is prefixA or u starts with (prefixA & "/") or u is prefixB or u starts with (prefixB & "/") then
							set URL of t to deepLink
							set current tab of w to t
							set index of w to 1
							activate
							return "reused"
						end if
					end repeat
				end repeat
			end tell
		end if
	end try
	do shell script "/usr/bin/open " & quoted form of deepLink
	return "opened"
end run
