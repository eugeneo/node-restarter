# node-restarter

Proof-of-concept for restarting the Node.JS process through the inspector debug protocol.

# Usage

1. Start the script `node restarter.js ${debugged_script_name} ${debugged_script_args}
2. Open Chrome devtools: chrome-devtools://devtools/bundled/inspector.html?experiments=true&ws=127.0.0.1:9229
3. Restart the Node process by pressing Ctrl+R (Windows and Linux) or Cmd+R (Mac)

# Notes

Currently, only a custom version of Node can be used with this script. That version can be built from https://github.com/eugeneo/node/tree/session-state branch.
