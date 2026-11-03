# Project Colors

Colors project folder icons and titles in the sidebar, plus conversations in
Activity, Recents and Pinned using their project's color. Subtle background tints
are optional. Projects are uncolored by default. Choose None, Auto, or
Blue, Green, Yellow, Red, Pink, Purple, Gray, or **Custom…** from **Project color…** in its
context/overflow menu or from the tweak's settings.

Background tints layer over the app's native row backgrounds, preserving hover,
selection, keyboard focus, and open-menu highlights in Activity and Recents.

Custom uses the installed Appearance settings' hue/saturation picker and a
six-digit hex field in a compact popup. The project dialog and tweak settings use
the actual Appearance settings dropdown components, including its rounded trigger,
color swatches, radio-menu selection indicators and keyboard navigation.
The dialog shows a live preview
of the project heading and an Activity conversation; **Apply** saves the choice
and **Cancel** discards it. The tweak settings save edits immediately.
The picker runs in the app's main
JavaScript world through a small host bridge. On first use it replays the app's
own lazy import of Appearance settings through the page's module runtime. Modules
and exports are discovered from their source and shape rather than pinned to a
build hash or module ID.

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
ignores animation style/class changes and conversation additions inside project groups.

Conversation membership is read by the same main-world bridge from live React
state, which the renderer's isolated world cannot reach. Activity rows use their
project group. Recents and pinned conversations use the home project the sidebar
resolved for the thread, so chats Codex keeps outside projects stay uncolored
even when their folder matches a project. Those project IDs resolve against
known project identities; ambiguous IDs shared by different project kinds stay
uncolored. Requires the current
desktop sidebar's semantic project attributes and the installed settings picker.
Windows is
the development platform; macOS needs real-app validation.
