# Bot engine

The bot engine is a separate process boundary from the HTTP API. It accepts a newline-delimited JSON supervisor protocol on stdin and emits status/chat/error events on stdout.

Supported commands:

- `{"action":"start","config":{...}}`
- `{"action":"stop","botId":"..."}`
- `{"action":"command","botId":"...","command":"/spawn"}`

Only validated Minecraft commands are sent to Mineflayer. Arbitrary JavaScript is never loaded or executed. The API-to-engine IPC adapter and persistent event bus are the next integration step.
