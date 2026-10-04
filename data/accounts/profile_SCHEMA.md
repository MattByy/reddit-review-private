# Account personality profile reference

Store one valid JSON object at `data/accounts/<account_id>/profile.json`, matching
an application account ID returned by `GET /api/agent/accounts`. This is a file
convention, not a validated JSON Schema or a profile-management API. The engine's
`personality_write` handler exists but is not accepted by current SQL validation.

```json
{
  "account_id": "account-b",
  "nickname": "Support voice",
  "archetype": "technical_support",
  "persona": "technical support",
  "writing_style": {
    "tone": "plainspoken",
    "vocabulary": "clear",
    "sentence_length": "short",
    "formatting": "short paragraphs",
    "punctuation": "standard"
  },
  "expertise": [
    {"domain": "HTTP troubleshooting", "depth": 4, "keywords": ["status codes"]}
  ],
  "topics_avoid": ["unverified product claims"],
  "activity": {
    "timezone": "Europe/Vilnius",
    "peak_hours": {"start": "09:00", "end": "17:00"},
    "session_length_min": 45,
    "posts_per_session": {"min": 1, "max": 3}
  }
}
```

| Field | Current consumer |
|---|---|
| `account_id` | Identifies profiles in assessment overlap diagnostics; keep equal to the directory/account ID |
| `nickname` | Voice brief label, falling back to database account label |
| `writing_style.tone`, `.vocabulary` | Injected into brief; defaults `professional`, `clear`. Also compared by assessment |
| `persona` | Assessment distinctiveness diagnostics |
| `expertise[].domain` | Assessment overlap diagnostics |
| `archetype`, other writing-style fields, expertise depth/keywords, `topics_avoid`, `activity` | Descriptive metadata; not automatically enforced or scheduled |

Voice injection is `[Voice: <nickname>] <brief>\nStyle: <tone>, <vocabulary>`.
No fabricated identity, credentials or customer experience should be inferred
from a profile. Shared ownership and the database account's `disclosure_line`
remain explicit in every draft. Profiles do not make accounts active or disclosed.

The drafting handler reads relative to the process working directory and silently
uses the original brief on read/parse errors. The legitimacy module resolves paths
relative to its own directory; missing files return null, but invalid JSON throws.
Ensure files are present in the deployment bundle before relying on them.

Validate a real profile locally:

```sh
python3 -m json.tool data/accounts/account-b/profile.json > /dev/null
```

The existing `acct_001/profile.json` is incomplete JSON in this checkout; use the
complete example above as your template. See [SEQUENCES_GUIDE.md](../../SEQUENCES_GUIDE.md)
for step configuration, supported voice-brief alternatives and report integration.
