# Tower of Hell Live Server Bot

Live Server V1 automates Carmine Hunt and XP Grinding private-server listings. Owners use `/carmine` or `/xp` in the private command channel; the bot publishes a minimal, role-pinging listing in the live channel and posts an owner-only control panel back in the command channel.

The SQLite database is the source of truth. Every listing stores its Discord message IDs and absolute expiration time. On startup the bot reconciles active records, removes anything that expired while offline, detects missing live messages, and resumes a periodic expiration sweep. Failed Discord cleanup is retained and retried rather than silently abandoned.

## Requirements

- Node.js 20 or newer
- A Discord application with a bot user
- Two text channels: `#live-servers` and `#server-bot-cmds`
- Two ping roles: Carmine Hunt and XP Grinding

No privileged gateway intents are required. In the Developer Portal, the bot only uses the standard `Guilds` and `Guild Messages` intents; Message Content, Server Members, and Presence can remain off.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and replace every placeholder. In Discord, enable **User Settings → Advanced → Developer Mode**, then right-click a channel or role and choose **Copy ID**.

   - `LIVE_SERVERS_CHANNEL_ID`: ID of `#live-servers`
   - `SERVER_COMMANDS_CHANNEL_ID`: ID of `#server-bot-cmds`
   - `CARMINE_ROLE_ID`: role pinged by `/carmine`
   - `XP_ROLE_ID`: role pinged by `/xp`
   - `DISCORD_GUILD_ID`: server ID
   - `DISCORD_CLIENT_ID`: application ID from the Developer Portal
   - `DISCORD_TOKEN`: bot token; never commit this value

3. Invite the bot using the OAuth2 scopes `bot` and `applications.commands`. Give it these channel permissions in both configured channels:

   - View Channel
   - Send Messages
   - Embed Links
   - Read Message History

   To ping roles that are not marked **Allow anyone to @mention this role**, also grant **Mention @everyone, @here, and All Roles**. The bot only deletes its own live messages, so **Manage Messages** is not required.

4. Ensure ordinary users cannot post in `#live-servers`. Give only approved private-server owners access to `#server-bot-cmds`, as intended by the server's role permissions.

5. Register the guild commands (guild registration updates quickly):

   ```sh
   npm run register:commands
   ```

6. Start in development mode:

   ```sh
   npm run dev
   ```

   Or build and run for production:

   ```sh
   npm run build
   npm start
   ```

Keep `data/live-servers.sqlite` on persistent storage. `DATABASE_PATH` can point elsewhere if needed. Only one bot process should use a database file at a time.

## Behavior and safeguards

- A listing starts with an exact two-hour lifetime.
- Every submitted URL is verified as Tower of Hell Place ID `1962086868` before any database record, live message, or role ping is created. Modern Roblox share links are resolved through a five-redirect, Roblox-host-only chain with an eight-second timeout. Verification failures fail closed.
- Owners can extend by exactly one hour only in the final ten minutes. The hour is added to the stored expiration, never to the click time. A transaction plus per-listing lock prevents double-click stacking.
- The creator's Discord user ID is checked on every button and change-link modal submission. UI visibility is not trusted.
- One active listing per owner per server type is enforced by both application logic and a partial unique database index.
- Changing a link edits the original live message without pinging again or changing expiration.
- Ending or expiration deletes the live message and disables the control panel. Nothing is posted to the live channel afterward.
- If the live message is manually deleted, the record is ended and its control panel is disabled.
- Transient Discord deletion/edit failures are logged; pending cleanup is retried every expiration sweep.

## Automated checks

Run:

```sh
npm test
npm run typecheck
```

The unit tests cover URL safety, duplicate constraints, exact extension arithmetic, early/stacked extension rejection, and atomic expiration claiming.

## Discord test plan

Use a test server or temporary roles/channels before production.

1. **Carmine:** Run `/carmine` in `#server-bot-cmds`, submit a valid Roblox private-server URL, and verify one Carmine role ping, the minimal live embed, a two-hour relative expiration, and a control panel.
2. **XP:** Repeat with `/xp`; verify the XP role and wording. Confirm the same owner may have one Carmine and one XP listing simultaneously.
3. **Channel restriction:** Try either command in another channel; verify an ephemeral rejection and no listing.
4. **Invalid/wrong-game URL:** Submit a non-Roblox, HTTP, Roblox URL without a private-server code, or a valid private-server URL for another Place ID; verify private rejection and no listing or role ping. Test both direct game URLs and modern `/share` links.
5. **Duplicate:** Run the same command again while its listing is active; verify no second live message or ping.
6. **Change link:** Press **Change Link**, submit another valid URL, and verify the existing live message changes while its message ID and expiration stay the same and no role is repinged.
7. **Ownership:** As a different user, trigger a copied button custom ID or interact with the visible panel; verify the ephemeral ownership rejection and unchanged record.
8. **Early extension:** Press **Extend +1h** with more than ten minutes remaining; verify rejection.
9. **Eligible extension:** For a practical test, create a listing and adjust its `expires_at` in a disposable database to 5–10 minutes ahead. Press **Extend +1h** and verify exactly 3,600,000 ms is added to the old expiration, both messages update, and an immediate second click is rejected.
10. **Manual end:** Press **End Server**; verify immediate deletion from `#live-servers`, disabled controls, ephemeral confirmation, and no extra live-channel message.
11. **Automatic expiration:** In a disposable database, set an active record's `expires_at` to the near future. Verify the bot deletes the live message and disables controls after the configured poll interval without posting an expiration notice.
12. **Restart persistence:** Create a listing, stop and restart the bot, and verify it remains manageable with the same expiration. Then stop the bot, set/wait for expiration, restart, and verify immediate cleanup.
13. **Manual deletion/API recovery:** Delete a live message manually and verify its panel becomes disabled. Temporarily remove a required permission during cleanup, verify the error is logged, restore permission, and verify a later sweep completes cleanup.

The Bingo system is intentionally not included; the command, interaction, persistence, scheduling, and live-server modules are separated so it can be added independently.
