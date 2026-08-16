# Tower of Hell Live Server Bot

Live Server V1 automates Carmine Hunt, XP Grinding, and Event private-server listings. Owners use `/hostgrind` in the private command channel, choose a session type, and submit their private-server link. The bot publishes a minimal, role-pinging listing in the live channel and posts an owner-only control panel back in the command channel.

The SQLite database is the source of truth. Every listing stores its Discord message IDs and absolute expiration time. On startup the bot reconciles active records, removes anything that expired while offline, detects missing live messages, and resumes a periodic expiration sweep. Failed Discord cleanup is retained and retried rather than silently abandoned.

## Requirements

- Node.js 20 or newer
- A Discord application with a bot user
- Four text channels: `#live-servers`, `#server-bot-cmds`, a staff-only reports channel, and a private session-logs channel
- Four roles: Carmine Hunt ping, XP Grinding ping, Event ping, and a moderator/staff role

No privileged gateway intents are required. In the Developer Portal, the bot only uses the standard `Guilds` and `Guild Messages` intents; Message Content, Server Members, and Presence can remain off.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and replace every placeholder. In Discord, enable **User Settings → Advanced → Developer Mode**, then right-click a channel or role and choose **Copy ID**.

   - `LIVE_SERVERS_CHANNEL_ID`: ID of `#live-servers`
   - `SERVER_COMMANDS_CHANNEL_ID`: ID of `#server-bot-cmds`
   - `CARMINE_ROLE_ID`: role pinged for Carmine Hunting
   - `XP_ROLE_ID`: role pinged for XP Grinding
   - `EVENT_ROLE_ID`: role pinged only for Event sessions
   - `STAFF_REPORTS_CHANNEL_ID`: staff-only channel receiving escalated report cases
   - `SESSION_LOGS_CHANNEL_ID`: private moderator channel receiving notable session-action logs
   - `MODERATOR_ROLE_ID`: role pinged on escalation and required for all moderation controls
   - `DISCORD_GUILD_ID`: server ID
   - `DISCORD_CLIENT_ID`: application ID from the Developer Portal
   - `DISCORD_TOKEN`: bot token; never commit this value

3. Invite the bot using the OAuth2 scopes `bot` and `applications.commands`. Give it these channel permissions in all configured channels:

   - View Channel
   - Send Messages
   - Embed Links
   - Read Message History

   In `LIVE_SERVERS_CHANNEL_ID`, also grant **Create Public Threads**, **Send Messages in Threads**, and **Manage Threads**. Each new live-session announcement creates one attached coordination thread, and Manage Threads lets the bot archive and lock it when the session ends.

   In the channel configured by `SERVER_COMMANDS_CHANNEL_ID`, also grant **Manage Messages** so the bot can keep the channel commands-only.

   To ping roles that are not marked **Allow anyone to @mention this role**, also grant **Mention @everyone, @here, and All Roles**.

4. Ensure ordinary users cannot post in `#live-servers`. Give only approved private-server owners access to `#server-bot-cmds`, as intended by the server's role permissions.

   Keep `STAFF_REPORTS_CHANNEL_ID` and `SESSION_LOGS_CHANNEL_ID` staff-only. Both channels need **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History**. The bot additionally verifies the configured moderator role and guild for `/hoststatus` and its controls; Administrator alone is not accepted.

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
- Owners can extend by exactly one hour only in the final 30 minutes. The hour is added to the stored expiration, never to the click time. A transaction plus per-listing lock prevents double-click stacking.
- After choosing Carmine, XP, or Event, the creator chooses **Self Hosted** or **Other** before entering the link. Self Hosted displays the creator; Other displays only `Other`, while the creator remains the internal controller. An optional, 500-character host message can be included without enabling user or role pings. Both values persist through restart reconciliation.
- The creator's Discord user ID is checked on every button and change-link modal submission. UI visibility is not trusted.
- `SERVER_COMMANDS_CHANNEL_ID` is commands-only: every normal message from a non-moderator is silently removed, including attachment-only messages and typed command text. Discord slash-command interactions remain unaffected. Members with the exact configured moderator role are exempt, bot/webhook messages and other channels are ignored, and deletion failures are logged internally without stopping the bot.
- One active listing per owner per server type is enforced by both application logic and a partial unique database index.
- A successful publication starts a persistent two-hour cooldown for that Discord user across all session types. Members with the exact configured `MODERATOR_ROLE_ID` bypass only this cooldown; their successful listings still update cooldown history. Opening `/hostgrind`, selecting a type, failed publication, link changes, extensions, reports, and moderation do not move the cooldown.
- Public announcements use a direct **Join Server** link button. Change Link and restart reconciliation rebuild it from the listing's latest verified URL, so its destination stays current.
- Each newly created Carmine, XP, or Event announcement gets exactly one attached coordination thread. Its ID is stored with the listing; Change Link, extension, and reconciliation never create another. Session cleanup archives and locks the thread without deleting it, and Discord thread failures never roll back hosting.
- Changing a link edits the original live message without pinging again or changing expiration.
- **End Session** remains available to the session host and can also be used by a member with the exact configured moderator role. Moderator membership is refetched from Discord before the override is accepted; Change Link and Extend remain host-only.
- Ending or expiration deletes the live message and disables the control panel. Nothing is posted to the live channel afterward.
- If the live message is manually deleted, the record is ended and its control panel is disabled.
- Transient Discord deletion/edit failures are logged; pending cleanup is retried every expiration sweep.
- Each live announcement has a public Report button. It opens a modal with a required reason (`host_not_in_server`, `server_missing`, `wrong_category`, or `other`) and optional details. `Other` requires details. Opening or cancelling the modal does not count; only a validated submission is stored.
- Report records retain the stable reason ID and up to 300 characters of optional detail. Existing databases are migrated automatically with nullable columns, so older reasonless reports remain valid history.
- The first unique report creates one quiet persistent **Reported Session** panel in the staff channel. At seven reports, the same case gains one separate **Urgent Report** message and pings `MODERATOR_ROLE_ID` exactly once; later reports refresh both existing messages without another ping.
- Staff cases show aggregated reason totals. Staff can inspect each reporter's reason, details, and history; blacklist troll reporters; ignore reports; or strike/remove the server. Ignored reports become rejected history; struck reports become valid history.
- One struck session can create only one host strike. At three active strikes, the host is persistently blocked from creating new listings.
- `/hoststatus user_id:<developer ID>` lets exact-role moderators inspect and manage strikes, both blacklist types, report history, and hosting cooldowns without requiring the target to remain in the guild. Its persistent ephemeral panel supports bounded strike changes, blacklist toggles, and the normal two-hour cooldown; every successful change is audited, logged privately, and restart-safe. The bot also attempts a private notification for each successful status change; delivery failure is logged and never rolls back moderation.
- Successful creation, extension, link change, host/moderator ending, natural expiration, manual public-message deletion, Strike / Remove, Reports Ignored, and strike-threshold host blacklisting write compact embeds only to `SESSION_LOGS_CHANNEL_ID`. End logs distinguish the original host, actual ending actor, and reason. Log failures never roll back the underlying action, and reconciliation does not fabricate event logs.
- Reports, outcomes, cases, blacklists, and strike history share the SQLite database and are reconciled without duplicate case messages after restart.

## Automated checks

Run:

```sh
npm test
npm run typecheck
```

The unit tests cover URL safety, duplicate constraints, exact extension arithmetic, early/stacked extension rejection, and atomic expiration claiming.

## Discord test plan

Use a test server or temporary roles/channels before production.

1. **Carmine:** Run `/hostgrind` in `#server-bot-cmds`, choose Carmine Hunting, choose Self Hosted or Other, submit a valid Roblox private-server URL and optional message, and verify one Carmine role ping, the selected host display, the minimal live embed, a two-hour relative expiration, and a control panel.
2. **XP:** Repeat with `/hostgrind` and choose XP Grinding; verify the XP role and wording. Confirm the two-hour per-user cooldown applies across all session types.
3. **Event:** Choose Event, submit a verified Tower of Hell private-server URL, and verify only the Event role is pinged. Confirm the Event title/description, Join Server button, controls, logging, expiration, and restart reconciliation use the same listing lifecycle.
3. **Channel restriction:** Try `/hostgrind` in another channel; verify an ephemeral rejection and no listing.
4. **Invalid/wrong-game URL:** Submit a non-Roblox, HTTP, Roblox URL without a private-server code, or a valid private-server URL for another Place ID; verify private rejection and no listing or role ping. Test both direct game URLs and modern `/share` links.
5. **Duplicate:** Run the same command again while its listing is active; verify no second live message or ping.
6. **Change link:** Press **Change Link**, submit another valid URL, and verify the existing live message changes while its message ID and expiration stay the same and no role is repinged.
7. **Ownership:** As a different user, trigger a copied button custom ID or interact with the visible panel; verify the ephemeral ownership rejection and unchanged record.
8. **Early extension:** Press **Extend +1h** with more than 30 minutes remaining; verify rejection.
9. **Eligible extension:** For a practical test, create a listing and adjust its `expires_at` in a disposable database to 5–30 minutes ahead. Press **Extend +1h** and verify exactly 3,600,000 ms is added to the old expiration, both messages update, and an immediate second click is rejected.
10. **Manual end:** Press **End Session**; verify immediate deletion from `#live-servers`, disabled controls, ephemeral confirmation, and no extra live-channel message.
11. **Automatic expiration:** In a disposable database, set an active record's `expires_at` to the near future. Verify the bot deletes the live message and disables controls after the configured poll interval without posting an expiration notice.
12. **Restart persistence:** Create a listing, stop and restart the bot, and verify it remains manageable with the same expiration. Then stop the bot, set/wait for expiration, restart, and verify immediate cleanup.
13. **Manual deletion/API recovery:** Delete a live message manually and verify its panel becomes disabled. Temporarily remove a required permission during cleanup, verify the error is logged, restore permission, and verify a later sweep completes cleanup.

The Bingo system is intentionally not included; the command, interaction, persistence, scheduling, and live-server modules are separated so it can be added independently.
