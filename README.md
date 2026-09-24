# CodexDC Tweaks

Optional tweaks for [CodexDC](https://github.com/DOCaCola/CodexDC).
Install and update them from the **Tweak Store** inside CodexDC.

| Tweak | Purpose |
| --- | --- |
| Hide Get Plus Button | Hide the profile upgrade control |
| Message Timestamps | Display message timestamps |
| Restart Session Command | Add a command to restart the shared local backend |
| Shell Display Fixes | Simplify displayed MSYS shell prefixes on Windows |

Mac compatibility is pending real-app validation. The restart command affects
the shared local backend, so finish active tasks before using it.

Each tweak keeps its own manifest version and stable ID. The generated catalog
pins an exact source commit and subdirectory. Local edited copies are not
silently replaced. CodexDC app maintenance is independent of these tweaks.

## Development

Use Node 24, `npm ci`, then `npm test`.
After committing source, `npm run catalog` generates `dist/index.json`.
The catalog workflow tests and publishes that file as the `catalog` release asset.

See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE) for attribution.
