---
"edmund-harness": patch
---

A household's note title is pinned the first time Edmund confirms the note (`kitchen_shopping noteWritten:true`). Before, a household with no `note_list` derived its title from the people's names every time, so naming somebody later pointed the kitchen and the screen scope at a note that did not exist. The note sync then refused to open the real one, and could never succeed. `service.sh` now removes an installed LaunchAgent before rendering its template. If the agent was a symlink to the template, rendering wrote through the link and emptied the tracked file.
