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

codex-lb decides the model list. For composer predictions it currently offers
only its native OpenAI models, so threads on Claude or OpenRouter models keep
predictions off.

While a codex-lb provider offers composer predictions, the tweak makes the
"Show predictions" setting available even when OpenAI's prediction rollout has
not reached the signed-in account. Turn the setting on to use predictions.
OpenAI's prediction configuration still decides the prompt, the reasoning effort
and the excluded models. Threads on the built-in `openai` provider keep OpenAI's
rollout decision.

Capabilities refresh at startup, when `config.toml` changes and every 15
minutes. The desktop code is adjusted while it loads, so enabling the tweak takes
effect after restarting Codex. Disabling it restores the original behaviour
immediately. If a Codex update changes the affected code, the feature stays
limited to the `openai` provider and the tweak logs the unsupported build.

Bundles [smol-toml](https://github.com/squirrelchat/smol-toml) 1.9.1
(BSD-3-Clause, see `vendor/smol-toml.LICENSE`) to read the Codex configuration.
