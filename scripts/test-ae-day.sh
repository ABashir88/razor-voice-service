#!/bin/bash
echo "═══════════════════════════════════════════════════════════════"
echo "  🔪 RAZOR AE DAY TEST"
echo "═══════════════════════════════════════════════════════════════"
echo ""

TESTS=(
    "Razor, good morning"
    "Razor, what's on my calendar today?"
    "Razor, any urgent emails?"
    "Razor, look up Marcus"
    "Razor, I just got off a call with Marcus. He pushed back on pricing."
    "Razor, what's my pipeline?"
    "Razor, search the web for Telnyx news"
)

for cmd in "${TESTS[@]}"; do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📢 Say: $cmd"
    read -p "Press ENTER after testing..."
done

echo "TEST COMPLETE"
