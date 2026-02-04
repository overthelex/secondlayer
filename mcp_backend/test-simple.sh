#!/bin/bash
# Simplest possible test
echo "Script started" >&2
echo "User: $(whoami)" >&2
echo "PWD: $(pwd)" >&2
/usr/bin/node --version >&2
echo "Test complete" >&2
