# Razor Brain Intelligence Agent

FastAPI-based intelligence server using Claude API for sales coaching and conversation processing.

## Architecture

- **Server**: FastAPI + Uvicorn
- **AI Model**: Claude Sonnet 4.5 (claude-sonnet-4-20250514)
- **Protocol**: WebSocket + REST
- **Port**: 127.0.0.1:8780

## Installation

```bash
cd brain
pip3 install -r requirements.txt
```

## Configuration

Add to `.env`:
```
ANTHROPIC_API_KEY=your_api_key_here
```

## Running the Server

```bash
# From brain directory
python3 -m razor_brain.server

# Or using the installed command (if in PATH)
razor-brain
```

## API Endpoints

### WebSocket: `ws://127.0.0.1:8780/ws`

**Client sends:**
```json
{
  "text": "I just got off a call with Acme Corp",
  "metadata": {"source": "voice_pipeline"},
  "stream": false,
  "request_id": "req_123"
}
```

**Server responds:**
```json
{
  "type": "response",
  "request_id": "req_123",
  "text": "How did it go? What was discussed?",
  "intent": "question",
  "entities": [
    {"name": "Acme Corp", "type": "company"}
  ],
  "actions": [
    {"action": "log_call", "params": {"company": "Acme Corp"}}
  ],
  "state": "debriefing",
  "latency_ms": 150
}
```

### REST Endpoints

**GET /health** - Health check
```json
{
  "status": "ok",
  "model": "claude-sonnet-4-20250514"
}
```

**POST /session/new** - Create conversation session
```json
{
  "session_id": "session_a1b2c3d4e5f6g7h8"
}
```

**POST /process** - Process single message (alternative to WebSocket)
```json
{
  "text": "user utterance",
  "metadata": {},
  "stream": false,
  "request_id": "req_456"
}
```

## Intent Classification

- **greeting**: Initial hello, how are you
- **question**: Asking for information (contact lookup, deal status, research)
- **action_request**: Explicit ask to do something (send email, log call, schedule meeting)
- **objection**: Customer pushback or concern being relayed
- **closing**: Goodbye, end of conversation

## State Tracking

- **listening**: Ready for input
- **debriefing**: Processing call/meeting debrief
- **researching**: Looking up information
- **coaching**: Providing objection handling or sales advice
- **acting**: Executing requested actions

## Actions

### log_call
Log a call summary to CRM
```json
{"action": "log_call", "params": {"contactId": "123", "notes": "...", "outcome": "positive"}}
```

### research
Search for company/prospect information
```json
{"action": "research", "params": {"query": "Clearwater Capital recent news", "type": "company_news"}}
```

### send_email
Draft and send follow-up
```json
{"action": "send_email", "params": {"to": "john@acme.com", "subject": "Follow up", "body": "..."}}
```

### schedule_meeting
Schedule a calendar event
```json
{"action": "schedule_meeting", "params": {"title": "Demo", "duration_min": 60, "participants": ["john@acme.com"]}}
```

### update_crm
Update deal or contact record
```json
{"action": "update_crm", "params": {"dealId": "456", "field": "stage", "value": "negotiation"}}
```

### get_context
Look up contact/deal/account details
```json
{"action": "get_context", "params": {"type": "contact", "id": "789"}}
```

## Testing

```bash
# Run all tests
python3 -m pytest tests/test_server.py -v

# Run specific test
python3 -m pytest tests/test_server.py::test_health_endpoint -v
```

**Test Coverage:**
- ✅ Health endpoint
- ✅ Session management
- ✅ BrainEngine initialization
- ✅ Message processing
- ✅ Error handling
- ✅ Conversation history
- ✅ WebSocket protocol
- ✅ Model serialization

All 15 tests passing.

## Sales Coaching System Prompt

The brain uses a specialized system prompt for enterprise B2B sales:

- **Call/Meeting Debriefs**: Accumulates details across turns, summarizes key points
- **Objection Handling**: LAER, Feel-Felt-Found, and other proven techniques
- **Research**: Prospect/account information lookup
- **Follow-ups**: Draft emails and schedule meetings
- **Context Tracking**: Maintains conversation continuity with entities and history

## Entity Extraction

Automatically detects and tracks:
- **person**: Names of contacts, prospects, executives
- **company**: Organization names, account names
- **deal**: Deal names, opportunity names
- **date**: Dates, times, time references
- **phone**: Phone numbers
- **email**: Email addresses
- **location**: Cities, countries, regions

## Example Conversation

**User:** "I just got off the phone with Marcus at Clearwater"

**Razor:**
```json
{
  "text": "How did the call go? What did you discuss?",
  "intent": "question",
  "entities": [
    {"name": "Marcus", "type": "person"},
    {"name": "Clearwater", "type": "company"}
  ],
  "state": "debriefing"
}
```

**User:** "He said it's too expensive"

**Razor:**
```json
{
  "text": "Classic pricing objection. Try this: 'I understand cost is a concern. Many of our clients felt the same way initially, but found that the ROI justified the investment within 3 months. What specific budget constraints are you working with?' This shifts from defending price to understanding their business.",
  "intent": "objection",
  "state": "coaching",
  "actions": [
    {"action": "get_context", "params": {"type": "deal", "company": "Clearwater"}}
  ]
}
```

## Architecture Notes

Following CLAUDE.md conventions:
- ✅ ES modules (Python equivalent: modern imports)
- ✅ Environment-based config
- ✅ Structured logging
- ✅ Graceful error handling
- ✅ No hardcoded commands (all AI-driven)
- ✅ Comprehensive tests

## Integration with Razor Voice Pipeline

The voice pipeline connects to this brain server via WebSocket:
1. User speaks wake word ("Razor")
2. Voice pipeline captures speech
3. Speech-to-text (Deepgram) transcribes
4. Transcript sent to brain via WebSocket
5. Brain processes with Claude AI
6. Response sent back to pipeline
7. Text-to-speech (Telnyx/ElevenLabs) speaks response

The brain maintains conversation state and context across the entire session.
