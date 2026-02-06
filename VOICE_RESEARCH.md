# TTS Voice Quality Research – Razor Voice Agent

## Goal
Select the most natural-sounding male voice for a home assistant that speaks through Mac Mini speakers. Priority: naturalness > latency > cost.

---

## Telnyx TTS

Telnyx uses a custom neural TTS engine with ~20 stock voices. Audio is generated server-side and returned as WAV/MP3.

### Best Male Voices (ranked)

| Rank | Voice ID | Character | Best For |
|------|----------|-----------|----------|
| 1 | **Telnyx.KeeganM** | Warm baritone, natural cadence, slight breathiness | General assistant, conversational |
| 2 | Telnyx.ChrisM | Brighter, clear enunciation | Alerts, dictation |
| 3 | Telnyx.BrianM | Deep, authoritative | Urgent notifications |

### Pros
- Low latency (~200-400ms to first byte)
- Included in Telnyx usage plan (no per-character cost)
- SSML support for prosody control (rate, pitch, volume)
- 16kHz WAV output matches our capture pipeline

### Cons
- Smaller voice selection than ElevenLabs
- Less emotional range
- Occasional robotic artifacts on longer sentences

---

## ElevenLabs TTS

ElevenLabs offers the most natural-sounding voices in the market, using a proprietary neural codec model. Their `eleven_turbo_v2_5` model offers the best latency/quality tradeoff.

### Best Male Voices (ranked)

| Rank | Voice ID | Name | Character | Best For |
|------|----------|------|-----------|----------|
| 1 | **pNInz6obpgDQGcFmaJgB** | Adam | Deep, warm, broadcast quality | Primary assistant voice |
| 2 | TxGEqnHWrfWFTfGW9XjX | Josh | Conversational, friendly | Casual interactions |
| 3 | yoZ06aMxZJJ28mfd3POQ | Sam | Calm, articulate | End-of-day summaries |

### Pros
- Most natural prosody in the industry
- Excellent emotional range via stability/similarity controls
- Voice cloning capability (future: clone your own voice)
- Speed parameter for dynamic pacing
- 26+ languages

### Cons
- Higher latency (~300-600ms first byte with turbo model)
- Per-character pricing (~$0.30/1K chars on Pro)
- MP3 output (requires mp3 decode or afplay handles it)

---

## Recommendation

### Development Phase → **Telnyx.KeeganM**
- Lower latency = faster iteration
- No per-character cost
- Good enough for testing the full pipeline

### Production Phase → **ElevenLabs "Adam"**
- Noticeably more natural
- Better emotional range for dynamic pacing (urgent vs calm)
- The quality difference is immediately obvious in A/B testing

### Hybrid Approach (advanced)
Use Telnyx for short, fast responses (confirmations, alerts) and ElevenLabs for longer, conversational responses. Switch provider based on response length:
- < 50 chars → Telnyx (speed priority)
- ≥ 50 chars → ElevenLabs (quality priority)

---

## Dynamic Pacing Implementation

Both providers support pacing control:

| Pace | Rate | Pitch | Use Case |
|------|------|-------|----------|
| urgent | 1.15x | +2st | Time-sensitive alerts |
| normal | 1.0x | +0st | Default conversation |
| calm | 0.9x | -1st | End of day, bedtime |

Pacing is determined by:
1. Time of day (after 10pm → calm)
2. Message urgency flag from AI backend
3. User preference (future: configurable)
