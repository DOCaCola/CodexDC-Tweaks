# codex-lb

Integrates Codex desktop with [codex-lb](https://github.com/DOCaCola/codex-lb).
Codex desktop enables some features only for threads on the built-in `openai`
provider. Threads served through codex-lb use a custom provider, so those
features stay off even though codex-lb serves them. This tweak recognizes
codex-lb providers and enables the functionality codex-lb advertises.

This tweak asks every custom provider in `config.toml` whether it is codex-lb by
requesting `<base_url>/codex-lb/capabilities` with the credentials Codex uses
for that provider. A provider counts as codex-lb only when it answers with the
codex-lb capability document. Each capability in that document lists the models
it applies to, and a feature is enabled only for threads on one of those models:

| Capability | Desktop feature |
| --- | --- |
| `composer_predictions` | Predicts your next message in the composer |
| `usage` | Shows codex-lb's quota pools behind the usage icon in the navigation rail |

codex-lb decides the model list. For composer predictions it currently offers
only its native OpenAI models, so threads on Claude or OpenRouter models keep
predictions off.

While a codex-lb provider offers composer predictions, the tweak makes the
"Show predictions" setting available even when OpenAI's prediction rollout has
not reached the signed-in account. Turn the setting on to use predictions.
OpenAI's prediction configuration still decides the prompt, the reasoning effort
and the excluded models. Threads on the built-in `openai` provider keep OpenAI's
rollout decision.

While a codex-lb provider offers `usage`, the usage icon in the navigation rail
opens a codex-lb popover instead of the signed-in account's usage menu. It reads
`<base_url>/codex-lb/usage`, which reports the readings codex-lb already stores
and sends nothing upstream. The popover leads with the pool that serves the
model selected in the composer, when the chat runs on a codex-lb provider; a new
chat uses the provider Codex starts new threads on. Below it, every pool shows
its tightest quota window, how many of its accounts are ready and when quota
returns. OpenRouter shows its remaining credits. "Coming up" lists refills and
expected run-outs of the next day, and the footer shows today's requests and
estimated cost for the provider's API key. While a codex-lb pool serves the
selected model, the icon becomes a ring showing how much of that pool's tightest
window is left.

Usage refreshes every minute while the main Codex window is visible, focused or
not, and pauses while it is hidden or minimized. Returning to the window and
opening the popover read fresh numbers unless the shown ones are only seconds
old; the refresh button always does. Codex's own account usage keeps updating as
before.

Capabilities refresh at startup, when `config.toml` changes and every 15
minutes. The desktop code is adjusted while it loads, so enabling the tweak takes
effect after restarting Codex. Disabling it restores the original behaviour
immediately. If a Codex update changes the affected code, the feature stays
limited to the `openai` provider and the tweak logs the unsupported build.
After each Codex update, the first start searches the desktop interface for the
feature switches in the background; later starts of that version reuse the
result.

Bundles [smol-toml](https://github.com/squirrelchat/smol-toml) 1.9.1
(BSD-3-Clause, see `vendor/smol-toml.LICENSE`) to read the Codex configuration.
