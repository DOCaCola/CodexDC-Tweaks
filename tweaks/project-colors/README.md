# Project Colors

Colors project folder icons and titles in the sidebar. Subtle background tints
are optional. Projects are uncolored by default. Choose None, Auto, or
Blue, Green, Yellow, Red, Pink, Purple, or Gray from **Project color…** in its
context/overflow menu or from the tweak's settings.

None restores the native project appearance. Auto explicitly enables a
deterministic color for that project.

Manual choices use the app's project kind and ID, so renaming a project preserves
its color and equal display names do not share preferences. Choices synchronize
between windows. Disabling the tweak removes its styling and menu items.

Inspired by [Bennett's UI Improvements](https://github.com/b-nnett/codex-plusplus-bennett-ui).
[CodexPlusPlus issue #1336](https://github.com/BigPizzaV3/CodexPlusPlus/issues/1336)
reports stuttering when expanding/collapsing projects with several conversations.
The report has no trace or confirmed cause. This implementation uses sidebar
attributes and CSS, without layout measurements during recoloring. Its observer
ignores animation style/class changes and conversation-only additions.

Requires the current desktop sidebar's semantic project attributes. Windows is
the development platform; macOS needs real-app validation.
