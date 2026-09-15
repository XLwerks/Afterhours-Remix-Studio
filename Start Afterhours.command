#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
/usr/bin/python3 server.py --open
if [ $? -ne 0 ]; then
  echo "Afterhours could not start. Read the message above."
  read -r -p "Press Return to close this window. "
fi
