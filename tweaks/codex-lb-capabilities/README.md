# codex-lb Capabilities

Codex desktop enables some features only for threads on the built-in `openai`
provider. Threads served through codex-lb use a custom provider, so those
features stay off even though codex-lb serves them.

This tweak asks every custom provider in `config.toml` whether it is codex-lb by
requesting `<base_url>/codex-lb/capabilities` with the credentials Codex uses
for that provider. A provider counts as codex-lb only when it answers with the
codex-lb capability document. Features are then enabled per provider and per
capability:

| Capability | Desktop feature |
| --- | --- |
| `composer_predictions` | Predicts your next message in the composer |

Codex-side requirements, such as the remote prediction rollout and the
"Show predictions" setting, still apply.

Capabilities refresh at startup, when `config.toml` changes and every 15
minutes. The desktop code is adjusted while it loads, so enabling the tweak takes
effect after restarting Codex. Disabling it restores the original behaviour
immediately. If a Codex update changes the affected code, the feature stays
limited to the `openai` provider and the tweak logs the unsupported build.

Bundles [smol-toml](https://github.com/squirrelchat/smol-toml) 1.9.1
(BSD-3-Clause, see `vendor/smol-toml.LICENSE`) to read the Codex configuration.
