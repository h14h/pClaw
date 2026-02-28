# Discord Bot Setup Notes

Reference notes for writing a future setup guide.

## Developer Portal Settings

- **Public Bot**: Disable "Public Bot" in the Bot settings to prevent anyone else from adding the bot to their servers. This is the first line of defense against unauthorized use.
- **Privileged Intents**: The bot needs Message Content Intent enabled (required for reading message text in guild channels).

## Config: `allowed_channel_ids`

Controls which guild/server channels the bot responds in. DMs are always allowed regardless of this setting.

- `"all"` — respond in all channels (default)
- `"none"` — DM-only mode, rejects all guild/server channels
- `["id1", "id2"]` — whitelist specific channel IDs

## Config: `allowed_user_ids`

Restricts who can interact with the bot. Applies to both guild channels and DMs. Empty array = no restriction.

This is the primary access control mechanism — even if someone adds the bot to their server, only listed users can trigger responses.

## Config: `guild_id`

Only affects where the `/ask` slash command is registered. Does **not** restrict the message handler. If left empty, the slash command is registered globally (all guilds the bot is in).

## Layered Security Recommendations

1. **Disable "Public Bot"** — prevents unauthorized server invites entirely
2. **Set `allowed_user_ids`** — restricts who can use the bot even if it's in a server
3. **Set `guild_id`** — scopes the slash command to your server
4. **Set `allowed_channel_ids`** — limits which channels the bot responds in (optional, for noise reduction)
