# LLteacher Platform Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Scope note:** This is a **master plan** covering six phases. **Only Phase 1 (OpenRouter swap) is at execution-ready detail.** Phases 2–6 are scoped milestones; each one MUST be run through `/superpowers:writing-plans` against its own scope to produce execution-ready tasks before implementation. Do not attempt to execute Phases 2–6 from this document — the steps are not specified to the required granularity.

**Goal:** Generalize LLteacher's Django codebase into a shared platform that can host the four UW CDI-funded AI tutoring projects (Statistics, Polya coding tutor, Econ 24/7 tutor, Clinical Informatics tutor) with a fall-quarter pilot target.

**Architecture:** Keep the existing Django + Django-ORM + Bootstrap stack; extend it along six axes — multi-provider LLM routing (OpenRouter), pluggable agent runtimes, multi-tenancy, RAG with pgvector, Canvas LTI, and UW-blessed FERPA-compliant hosting. Defer the TS/React rewrite to a winter follow-on once pilots prove which UI patterns matter.

**Tech Stack:** Django 5.2, Python 3.12, uv workspaces, Django ORM, OpenRouter (Phase 1), pgvector + Neon Postgres (Phase 4), LTI 1.3 (Phase 5), WorkOS or UW SAML (Phase 6).

---

## Phase Dependency Graph

```
Phase 1: OpenRouter swap (independent, ships first)
        │
        ▼
Phase 2: Agent runtime abstraction (needs clean LLM call boundary from P1)
        │
        ▼
Phase 3: Multi-tenancy data model (re-keys everything; do before adding more tables)
        │
        ├──────────────┐
        ▼              ▼
Phase 4: RAG +     Phase 5: Canvas LTI 1.3
        pgvector   (multi-tenant identity mapping)
        │              │
        └──────┬───────┘
               ▼
Phase 6: UW hosting + FERPA/HIPAA (ongoing; cutover after P3+)
```

Calendar-week estimate against a 3-engineer SSE pod with AI-assisted dev:
- Phase 1: 3–5 days
- Phase 2: 2–3 weeks
- Phase 3: 1–2 weeks
- Phase 4: 1.5–2 weeks
- Phase 5: 2–2.5 weeks (gated by UW Canvas team availability)
- Phase 6: ongoing throughout; cutover ~1 week after P3

---

## Phase 1: OpenRouter Swap

**Goal:** Replace the direct OpenAI client with a configurable base-URL OpenAI client so each `LLMConfig` can route to OpenAI, OpenRouter, or any OpenAI-compatible provider (Azure OpenAI, vLLM, etc.). Unblocks Claude, Gemini, and open-weight model selection per course without code changes.

**Why this is Phase 1:** Smallest scope, zero dependencies, immediate value to all four PIs, validates the SSE engagement model on a low-risk change.

**File Structure:**

| File | Responsibility | Action |
|---|---|---|
| `apps/llm/src/llm/models.py` | `LLMConfig` model | Add `base_url` field |
| `apps/llm/src/llm/migrations/0003_llmconfig_base_url.py` | Schema migration | Create |
| `apps/llm/src/llm/services.py` | `LLMService` + OpenAI client | Wire `base_url` into client instantiation |
| `apps/llm/src/llm/views.py` | Form parsing | Add `base_url` to create/edit |
| `apps/llm/tests/test_services.py` | Service tests | Update mock assertions + add base_url tests |
| `apps/llm/tests/test_models.py` | Model tests | Add base_url default test |
| `apps/llm/templates/llm/config_form.html` | Config form | Add base_url field, expand model dropdown |
| `apps/llm/templates/llm/config_detail.html` | Detail view | Show base_url |
| `src/llteacher/management/commands/populate_test_database.py` | Seed data | Use OpenRouter URL in seed config |
| `README.md` | Setup docs | Document OpenRouter setup |

**Test command (use throughout):**
```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests
```

---

### Task 1: Add `base_url` field to `LLMConfig` model

**Files:**
- Modify: `apps/llm/src/llm/models.py:6-33`
- Create: `apps/llm/src/llm/migrations/0003_llmconfig_base_url.py`
- Modify: `apps/llm/tests/test_models.py`

- [ ] **Step 1: Write the failing test in `apps/llm/tests/test_models.py`**

Add this test method to the existing `LLMConfig` test class (or create a new class if needed):

```python
def test_base_url_defaults_to_openrouter(self):
    """New LLMConfig instances default base_url to OpenRouter's API."""
    config = LLMConfig.objects.create(
        name="Base URL Default Test",
        model_name="anthropic/claude-3.5-sonnet",
        api_key="sk-or-test",
        base_prompt="You are a tutor.",
    )
    self.assertEqual(config.base_url, "https://openrouter.ai/api/v1")

def test_base_url_accepts_custom_value(self):
    """LLMConfig stores any OpenAI-compatible base URL."""
    config = LLMConfig.objects.create(
        name="Custom Base URL",
        model_name="gpt-4o",
        api_key="sk-test",
        base_prompt="You are a tutor.",
        base_url="https://api.openai.com/v1",
    )
    self.assertEqual(config.base_url, "https://api.openai.com/v1")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests.test_models
```

Expected: FAIL with `AttributeError: 'LLMConfig' object has no attribute 'base_url'` or similar.

- [ ] **Step 3: Add `base_url` field to `LLMConfig`**

Edit `apps/llm/src/llm/models.py` and add the field after `api_key` (around line 11):

```python
class LLMConfig(models.Model):
    """Configuration for LLM integration."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100, unique=True)
    model_name = models.CharField(max_length=100, help_text="LLM model to use (e.g., 'anthropic/claude-3.5-sonnet', 'openai/gpt-4o')")
    api_key = models.CharField(max_length=255, help_text="API key for LLM service")
    base_url = models.URLField(
        max_length=500,
        default="https://openrouter.ai/api/v1",
        help_text="OpenAI-compatible API base URL (OpenRouter, OpenAI, Azure, etc.)",
    )
    base_prompt = models.TextField(help_text="Base prompt template for AI tutor")
    temperature = models.FloatField(
        default=0.7,
        validators=[MinValueValidator(0.0), MaxValueValidator(2.0)]
    )
    max_completion_tokens = models.PositiveIntegerField(default=1000)
    is_default = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'llm_config'

    def __str__(self):
        return f"{self.name} ({self.model_name})"

    def save(self, *args, **kwargs):
        """Ensure only one default config exists."""
        if self.is_default:
            LLMConfig.objects.filter(is_default=True).update(is_default=False)
        super().save(*args, **kwargs)
```

Also broaden the `model_name` help text as shown above.

- [ ] **Step 4: Generate the migration**

```bash
uv run python manage.py makemigrations llm --name llmconfig_base_url
```

Expected output: creates `apps/llm/src/llm/migrations/0003_llmconfig_base_url.py` adding the `base_url` field with the default value.

- [ ] **Step 5: Run tests to verify they pass**

```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests.test_models
```

Expected: PASS for both new tests; no existing test regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/llm/src/llm/models.py apps/llm/src/llm/migrations/0003_llmconfig_base_url.py apps/llm/tests/test_models.py
git commit -m "feat(llm): add base_url to LLMConfig for OpenRouter compatibility"
```

---

### Task 2: Wire `base_url` into both OpenAI client instantiations

**Files:**
- Modify: `apps/llm/src/llm/services.py:161` (blocking client)
- Modify: `apps/llm/src/llm/services.py:269` (streaming client)
- Modify: `apps/llm/tests/test_services.py:142-172`

- [ ] **Step 1: Update the existing test assertion to expect `base_url`**

In `apps/llm/tests/test_services.py`, change the assertion at line 169 from:

```python
mock_openai_class.assert_called_once_with(api_key=self.llm_config.api_key)
```

to:

```python
mock_openai_class.assert_called_once_with(
    api_key=self.llm_config.api_key,
    base_url=self.llm_config.base_url,
)
```

- [ ] **Step 2: Add a new streaming-client base_url test**

Append to `TestLLMServiceResponses` in `apps/llm/tests/test_services.py`:

```python
@patch('llm.services.OpenAI')
def test_stream_response_passes_base_url(self, mock_openai_class):
    """Streaming client must receive both api_key and base_url."""
    mock_client = MagicMock()
    mock_openai_class.return_value = mock_client

    # Mock a single-chunk stream that finishes
    mock_chunk = MagicMock()
    mock_chunk.choices = [MagicMock()]
    mock_chunk.choices[0].delta.content = "hi"
    mock_client.chat.completions.create.return_value = iter([mock_chunk])

    tokens = list(LLMService.stream_response(
        self.conversation,
        "Help me understand X.",
        "student",
    ))

    self.assertEqual(tokens, ["hi"])
    mock_openai_class.assert_called_once_with(
        api_key=self.llm_config.api_key,
        base_url=self.llm_config.base_url,
    )
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests.test_services
```

Expected: both `test_get_response` and `test_stream_response_passes_base_url` FAIL because the production code still calls `OpenAI(api_key=...)` without `base_url`.

- [ ] **Step 4: Update `_generate_openai_response` in `apps/llm/src/llm/services.py:161`**

Change:

```python
client = OpenAI(api_key=llm_config.api_key)
```

to:

```python
client = OpenAI(
    api_key=llm_config.api_key,
    base_url=llm_config.base_url,
)
```

- [ ] **Step 5: Update `_generate_streaming_openai_response` in `apps/llm/src/llm/services.py:269`**

Change:

```python
client = OpenAI(api_key=llm_config.api_key)
```

to:

```python
client = OpenAI(
    api_key=llm_config.api_key,
    base_url=llm_config.base_url,
)
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests.test_services
```

Expected: PASS for both updated and new tests; no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/llm/src/llm/services.py apps/llm/tests/test_services.py
git commit -m "feat(llm): route OpenAI client through configured base_url"
```

---

### Task 3: Surface `base_url` through the create/edit view layer

**Files:**
- Modify: `apps/llm/src/llm/services.py:43-51` (`LLMConfigCreateData`)
- Modify: `apps/llm/src/llm/views.py` (create/edit views; specifically the `_parse_create_form_data` around line 175 and `_parse_update_form_data` around line 257 per the research doc)
- Modify: `apps/llm/tests/test_views.py`

- [ ] **Step 1: Write a failing test in `apps/llm/tests/test_views.py`**

Add (or extend an existing) test class for the create flow:

```python
from django.test import TestCase, Client
from django.urls import reverse
from django.contrib.auth import get_user_model
from accounts.models import Teacher
from llm.models import LLMConfig

User = get_user_model()


class LLMConfigCreateViewBaseURLTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="t1@uw.edu", email="t1@uw.edu", password="pw"
        )
        Teacher.objects.create(user=self.user)
        self.client.force_login(self.user)

    def test_create_persists_base_url(self):
        response = self.client.post(reverse("llm:config-create"), {
            "name": "Custom Provider",
            "model_name": "anthropic/claude-3.5-sonnet",
            "api_key": "sk-or-test",
            "base_url": "https://example.openai.azure.com/v1",
            "base_prompt": "You are a tutor.",
            "temperature": "0.5",
            "max_completion_tokens": "500",
        })
        self.assertEqual(response.status_code, 302)
        config = LLMConfig.objects.get(name="Custom Provider")
        self.assertEqual(config.base_url, "https://example.openai.azure.com/v1")
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests.test_views.LLMConfigCreateViewBaseURLTest
```

Expected: FAIL — `LLMConfig.base_url` is left at its default because the view isn't reading the POSTed field.

- [ ] **Step 3: Add `base_url` to `LLMConfigCreateData`**

In `apps/llm/src/llm/services.py:43`, change to:

```python
@dataclass
class LLMConfigCreateData:
    name: str
    model_name: str
    api_key: str
    base_prompt: str
    base_url: str = "https://openrouter.ai/api/v1"
    temperature: float = 0.7
    max_completion_tokens: int = 1000
    is_default: bool = False
    is_active: bool = True
```

- [ ] **Step 4: Update `create_config` to persist `base_url`**

Locate the `LLMService.create_config(...)` body (around `apps/llm/src/llm/services.py:467`) and add `base_url=data.base_url` to the `LLMConfig.objects.create(...)` kwargs.

- [ ] **Step 5: Update `_parse_create_form_data` in `apps/llm/src/llm/views.py`**

Read the existing parser (around line 175) and add a line that pulls `base_url` from `request.POST`, falling back to the OpenRouter default:

```python
base_url=request.POST.get("base_url", "https://openrouter.ai/api/v1").strip()
            or "https://openrouter.ai/api/v1",
```

Pass it through to `LLMConfigCreateData(...)`.

- [ ] **Step 6: Update `_parse_update_form_data` in `apps/llm/src/llm/views.py`**

Locate the update parser (around line 257) and conditionally include `base_url` in the returned dict when the POST contains a non-empty value:

```python
base_url = request.POST.get("base_url", "").strip()
if base_url:
    update_data["base_url"] = base_url
```

`LLMService.update_config` already iterates the dict and applies fields by key, so no further service change is required — verify by reading `update_config` around line 504.

- [ ] **Step 7: Run tests to verify they pass**

```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests
```

Expected: PASS for all new tests; no regressions in `test_models`, `test_services`, or `test_views`.

- [ ] **Step 8: Commit**

```bash
git add apps/llm/src/llm/services.py apps/llm/src/llm/views.py apps/llm/tests/test_views.py
git commit -m "feat(llm): accept base_url in create/edit views"
```

---

### Task 4: Update the config form template

**Files:**
- Modify: `apps/llm/templates/llm/config_form.html:41-50` (model dropdown)
- Modify: `apps/llm/templates/llm/config_form.html:55-60` (add base_url field before api_key)
- Modify: `apps/llm/templates/llm/config_detail.html` (show base_url in the detail `<dl>`)

- [ ] **Step 1: Replace the model dropdown with an OpenRouter-style identifier list**

In `apps/llm/templates/llm/config_form.html`, replace lines 41–48 (the `<select>` and its `<option>` children) with:

```html
<select class="form-select" id="model_name" name="model_name" required>
    <option value="">Select a model...</option>
    <optgroup label="Anthropic (via OpenRouter)">
        <option value="anthropic/claude-3.5-sonnet" {% if data.config.model_name == 'anthropic/claude-3.5-sonnet' or form_data.model_name == 'anthropic/claude-3.5-sonnet' %}selected{% endif %}>Claude 3.5 Sonnet</option>
        <option value="anthropic/claude-3.5-haiku" {% if data.config.model_name == 'anthropic/claude-3.5-haiku' or form_data.model_name == 'anthropic/claude-3.5-haiku' %}selected{% endif %}>Claude 3.5 Haiku</option>
    </optgroup>
    <optgroup label="OpenAI (direct or via OpenRouter)">
        <option value="openai/gpt-4o" {% if data.config.model_name == 'openai/gpt-4o' or form_data.model_name == 'openai/gpt-4o' %}selected{% endif %}>GPT-4o</option>
        <option value="openai/gpt-4o-mini" {% if data.config.model_name == 'openai/gpt-4o-mini' or form_data.model_name == 'openai/gpt-4o-mini' %}selected{% endif %}>GPT-4o Mini</option>
        <option value="gpt-4o" {% if data.config.model_name == 'gpt-4o' or form_data.model_name == 'gpt-4o' %}selected{% endif %}>gpt-4o (direct OpenAI)</option>
        <option value="gpt-4o-mini" {% if data.config.model_name == 'gpt-4o-mini' or form_data.model_name == 'gpt-4o-mini' %}selected{% endif %}>gpt-4o-mini (direct OpenAI)</option>
    </optgroup>
    <optgroup label="Google (via OpenRouter)">
        <option value="google/gemini-2.0-flash-exp" {% if data.config.model_name == 'google/gemini-2.0-flash-exp' or form_data.model_name == 'google/gemini-2.0-flash-exp' %}selected{% endif %}>Gemini 2.0 Flash</option>
    </optgroup>
</select>
<div class="form-text">OpenRouter-style identifiers (e.g., <code>anthropic/claude-3.5-sonnet</code>) or bare OpenAI names if pointing at the direct OpenAI endpoint.</div>
```

- [ ] **Step 2: Add a `base_url` input above the API key field**

In `apps/llm/templates/llm/config_form.html`, insert this block immediately before the existing `api_key` block (currently at line 54):

```html
<div class="mb-3">
    <label for="base_url" class="form-label">API Base URL</label>
    <input type="url" class="form-control" id="base_url" name="base_url"
           value="{% if data.config %}{{ data.config.base_url }}{% elif form_data %}{{ form_data.base_url }}{% else %}https://openrouter.ai/api/v1{% endif %}">
    <div class="form-text">
        OpenAI-compatible endpoint. Defaults to <code>https://openrouter.ai/api/v1</code>.
        Use <code>https://api.openai.com/v1</code> for a direct OpenAI key.
    </div>
</div>
```

- [ ] **Step 3: Surface `base_url` on the detail page**

Open `apps/llm/templates/llm/config_detail.html` and locate the `<dl>` block listing model_name, temperature, etc. (around line 40 per the research doc). Add a `<dt>`/`<dd>` pair for `base_url`:

```html
<dt class="col-sm-4">Base URL</dt>
<dd class="col-sm-8"><code>{{ data.config.base_url }}</code></dd>
```

- [ ] **Step 4: Manually render the form and verify**

```bash
uv run python manage.py runserver
```

Visit `http://localhost:8000/llm/create/`, log in as a teacher, confirm:
- The base_url field renders with the OpenRouter default prefilled.
- The model dropdown shows the new grouped options.
- Submitting the form persists the chosen base_url (check via the detail page).

- [ ] **Step 5: Commit**

```bash
git add apps/llm/templates/llm/config_form.html apps/llm/templates/llm/config_detail.html
git commit -m "feat(llm): expose base_url and provider-grouped model picker in admin UI"
```

---

### Task 5: Update the seed-data command

**Files:**
- Modify: `src/llteacher/management/commands/populate_test_database.py:122-162` (the `create_llm_config` method)

- [ ] **Step 1: Update the seeded `LLMConfig` to use an OpenRouter-style identifier and base_url**

In `src/llteacher/management/commands/populate_test_database.py`, locate the `LLMConfig.objects.create(...)` call inside `create_llm_config` and change:

```python
LLMConfig.objects.create(
    name='Test GPT-4 Config',
    model_name='gpt-5',
    api_key='test-api-key-placeholder',
    base_prompt='...long string...',
    temperature=0.7,
    max_completion_tokens=1000,
    is_default=True,
    is_active=True,
)
```

to:

```python
LLMConfig.objects.create(
    name='Test OpenRouter Config',
    model_name='anthropic/claude-3.5-haiku',
    api_key='test-api-key-placeholder',
    base_url='https://openrouter.ai/api/v1',
    base_prompt='...long string...',
    temperature=0.7,
    max_completion_tokens=1000,
    is_default=True,
    is_active=True,
)
```

Preserve the existing long `base_prompt` string verbatim — do not retype it.

- [ ] **Step 2: Run the seed against an in-memory DB to verify it loads**

```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests
```

(The test DB rebuilds from migrations; this confirms migrations + seed model both work end-to-end.)

Expected: PASS.

- [ ] **Step 3: Run the populate command against the dev DB**

```bash
uv run python manage.py populate_test_database --reset
```

Expected: command exits 0 with the printed summary; the `LLMConfig` row has the new name, `model_name='anthropic/claude-3.5-haiku'`, and `base_url='https://openrouter.ai/api/v1'`.

- [ ] **Step 4: Commit**

```bash
git add src/llteacher/management/commands/populate_test_database.py
git commit -m "chore(seed): default seeded LLMConfig to OpenRouter Claude Haiku"
```

---

### Task 6: Update README configuration section

**Files:**
- Modify: `README.md` (Configuration / API Key Setup section)

- [ ] **Step 1: Rewrite the "API Key Setup" section**

Replace the existing "Option 1: Through Admin Interface" / "Option 2: Update Test Database Population" / "Getting an OpenAI API Key" subsections with:

```markdown
### LLM Provider Setup

LLteacher routes all model calls through OpenAI-compatible endpoints. By default each `LLMConfig` points at OpenRouter (`https://openrouter.ai/api/v1`), which gives you OpenAI, Anthropic, Google, and open-weight models behind a single key.

#### Recommended: OpenRouter (multi-provider)

1. Create an account and key at https://openrouter.ai/keys
2. Start the dev server: `python manage.py runserver`
3. Sign in at `/admin/`, edit the seeded `LLMConfig`, and paste your key into **API Key**. Leave **API Base URL** at the OpenRouter default.
4. Choose a model in the **Model Name** dropdown (e.g., `anthropic/claude-3.5-sonnet`).

#### Alternative: Direct OpenAI

If you have an enterprise OpenAI key (e.g., via UW-IT) and want to bypass OpenRouter:
- Set **API Base URL** to `https://api.openai.com/v1`
- Set **Model Name** to a bare OpenAI identifier (`gpt-4o`, `gpt-4o-mini`)

#### Alternative: Azure OpenAI

- Set **API Base URL** to your Azure deployment URL (`https://<resource>.openai.azure.com/openai/deployments/<deployment>/`)
- Set **Model Name** to the deployment name

#### Testing your configuration

Use the **Test Configuration** button on the LLM config detail page. It sends a one-shot request and returns the response text + token count.
```

- [ ] **Step 2: Update the troubleshooting note**

Find the "No valid LLM configuration available" line in the existing Troubleshooting section and append:

```markdown
- Verify the **API Base URL** matches your provider (OpenRouter, OpenAI, or Azure). A wrong base URL surfaces as a generic technical-issue message with a reference ID.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document OpenRouter as default LLM provider"
```

---

### Phase 1 Done-Definition

Run the full Phase 1 test suite plus a manual smoke test:

```bash
uv run python run_tests.py --settings=src.llteacher.test_settings apps.llm.tests
uv run python manage.py migrate --check
uv run python manage.py populate_test_database --reset
uv run python manage.py runserver
```

Manually verify:
- [ ] Create a new LLMConfig pointed at OpenRouter with a real key, model `anthropic/claude-3.5-haiku`.
- [ ] Start a conversation as a student on a seeded section; confirm the AI tutor responds.
- [ ] Repeat with model `openai/gpt-4o-mini` (same OpenRouter key).
- [ ] Repeat with a direct-OpenAI config (`base_url=https://api.openai.com/v1`, `model_name=gpt-4o-mini`); confirm the AI tutor responds.
- [ ] Streaming path: verify the SSE chat (`/conversations/api/<id>/stream/`) still emits tokens against the new providers.

---

## Phase 2: Agent Runtime Abstraction

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Extract the LLM-call logic from `LLMService` and the AI-message-creation logic from `ConversationService` into a pluggable `AgentRuntime` interface so each Course can be backed by a different runtime (single-prompt LLteacher, Polya 4-phase state machine, RAG-grounded, future multi-agent).

**Depends on:** Phase 1 (clean OpenAI-compatible client boundary).

**Proposed interface (to be validated in a brainstorming session):**

```python
# New file: apps/llm/src/llm/runtimes/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Iterator
from uuid import UUID

@dataclass(frozen=True)
class TurnInput:
    conversation_id: UUID
    user_message: str
    message_type: str  # 'student' | 'code' | ...

@dataclass(frozen=True)
class TurnEvent:
    """A discrete event a runtime emits while processing a turn."""
    kind: str  # 'ai_token' | 'ai_message_complete' | 'tool_call' | 'phase_transition' | 'error'
    data: dict

class AgentRuntime(ABC):
    """Per-Course strategy for processing one conversation turn."""

    @abstractmethod
    def run_turn(self, turn: TurnInput) -> Iterator[TurnEvent]:
        """Yield events as the turn is processed. Persistence is the runtime's job."""

    @abstractmethod
    def initial_message(self, conversation_id: UUID) -> str:
        """Return the opening message when a conversation starts."""
```

**Files affected (rough scope):**
- Create: `apps/llm/src/llm/runtimes/__init__.py`, `runtimes/base.py`, `runtimes/single_prompt.py` (today's LLteacher logic), `runtimes/polya.py` (state machine for Laurel's tutor), `runtimes/registry.py` (name → class mapping)
- Modify: `apps/conversations/src/conversations/services.py` — `ConversationService.process_message` delegates to a runtime resolved from the conversation's course
- Modify: `apps/conversations/src/conversations/views.py:344` — SSE view yields runtime events directly
- Modify: `apps/llm/src/llm/models.py` — add `runtime_name` field to `LLMConfig` (or `Course` once multi-tenancy lands)
- Migration: add `runtime_name` column with default `'single_prompt'`
- Tests: `apps/llm/tests/test_runtimes_single_prompt.py`, `apps/llm/tests/test_runtimes_polya.py`

**Key design questions to settle in brainstorming:**
1. Is the runtime stateful per conversation, or stateless with state pulled from messages each turn? (Polya needs phase tracking.)
2. How does a runtime persist its own state? (New `ConversationRuntimeState` table? Re-derive from message history?)
3. Where does message persistence happen — inside the runtime or in `ConversationService`? (Today the per-token save lives in `ConversationService._process_streaming_response:562-564`.)
4. How are tools (R execution result ingestion, future RAG document retrieval, Polya's readiness sub-call) modeled? (LangChain-style ReAct? Vercel AI SDK tool-call shape?)
5. What's the contract for emitting events? (Pure `Iterator[TurnEvent]`? Async generator? Both for parity with the SSE endpoint?)
6. Where does the runtime selection live — `Course.default_runtime`, `LLMConfig.runtime`, or `Homework.runtime`?

**Estimated effort:** 2–3 weeks with AI-assisted dev.

**Next step:** Run `/superpowers:brainstorming` against the design questions above, then `/superpowers:writing-plans` against the resulting spec.

---

## Phase 3: Multi-Tenancy Data Model

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Add `Organization` → `Course` → `Instructor` above `Homework` so one deployment can host the four CDI projects (and future ones) without colliding on data, prompts, runtimes, or LLM configs.

**Depends on:** Phase 1 (so per-course LLM routing has a target); should land before Phase 4 to avoid re-keying documents/embeddings.

**Files affected (rough scope):**
- Create: `apps/orgs/` (new Django app) with models `Organization`, `Course`, `CourseMembership`
- Modify: `apps/homeworks/src/homeworks/models.py:7-31` — `Homework.course = ForeignKey('orgs.Course', ...)`; deprecate direct `created_by → Teacher` (move teacher to `CourseMembership(role='instructor')`)
- Modify: `apps/accounts/src/accounts/models.py` — replace single global `Teacher`/`Student` with `CourseMembership(role)` (or keep profiles for global-role hints and add per-course memberships on top)
- Modify: every queryset in `apps/homeworks`, `apps/conversations`, `apps/llm` to filter by current course
- Modify: every permission decorator in `src/llteacher/permissions/decorators.py:37-192` to scope by course
- Create: middleware or context processor that resolves the current `Course` from URL or session
- Migration: data migration that creates a default Organization + Course and back-fills FKs on existing rows

**Key design questions to settle in brainstorming:**
1. Is `Course` keyed by URL slug (`/c/<slug>/...`), subdomain (`<slug>.llteacher.uw.edu`), or session state?
2. Do students belong to one course at a time or many? (Affects `Conversation.user` semantics.)
3. Are `LLMConfig` rows global or per-Org? (Probably per-Org — Lakshmi's HIPAA constraints don't apply to Ali's econ class.)
4. Does the seeded admin superuser need to belong to every org, or to a special "platform" org with cross-org visibility?
5. How does the migration handle the existing single-tenant SQLite deployment Sara is running?
6. Soft-delete-or-archive semantics for inactive Orgs/Courses (term-over-term cleanup)?

**Estimated effort:** 1–2 weeks with AI-assisted dev; migration is the riskiest part.

**Next step:** Brainstorm against the questions above, then write a Phase 3 plan that explicitly sequences the data migration to preserve Sara's 180-student dataset.

---

## Phase 4: RAG + pgvector + Document Upload

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Let instructors upload course materials (PDFs, slides, lecture transcripts), chunk + embed them with pgvector, and ground LLM responses in those materials via the `RAGGroundedRuntime` from Phase 2. Unlocks Ali (econ) and Lakshmi (clinical informatics).

**Depends on:** Phase 2 (so the RAG behavior is a runtime variant, not a special-case in `LLMService`), Phase 3 (so documents are scoped per course).

**Files affected (rough scope):**
- Modify: `src/llteacher/settings.py:71-76` and `src/llteacher/production.py:79-84` — switch `DATABASES` from SQLite to Postgres (Neon connection string via env var)
- Add: `psycopg[binary]`, `pgvector` to `pyproject.toml`
- Create: `apps/documents/` Django app with models `Document`, `DocumentChunk(embedding=VectorField(1536))`, `DocumentIngestJob`
- Create: `apps/documents/src/documents/services.py` — upload → text extract (PyMuPDF for PDFs, python-pptx for slides) → chunk (token-aware) → embed (via OpenRouter or direct OpenAI embedding endpoint) → persist
- Create: `apps/documents/src/documents/retrieval.py` — `retrieve_chunks(course, query, k=8)` returning ranked `DocumentChunk`s via pgvector cosine similarity
- Create: `apps/llm/src/llm/runtimes/rag_grounded.py` — Phase 2 runtime that retrieves chunks and injects them into the prompt
- Templates: upload page, document list, per-document chunk viewer (for debugging)

**Key design questions to settle in brainstorming:**
1. Embedding model — `text-embedding-3-small` (cheap, 1536d) or `text-embedding-3-large` (better, 3072d)?
2. Chunk strategy — fixed-token windows, semantic splitting, or document-structure-aware (slides → one chunk per slide; PDFs → one chunk per heading)?
3. Where does the retrieval call happen in the runtime — before the system prompt or as a tool-call the model invokes when needed?
4. Reranking — keep simple cosine top-k, or add a cross-encoder reranker?
5. Hybrid search — vector only, or vector + BM25?
6. Document update / re-embed lifecycle when instructors edit materials.
7. Async ingestion job runner — Django-Q, dramatiq, or sync-with-progress-bar for v1?

**Estimated effort:** 1.5–2 weeks with AI-assisted dev; the Postgres/SQLite cutover is the biggest unknown.

**Next step:** Brainstorm against the questions above; consider running a 1-day spike to validate embedding cost + retrieval quality against a sample of Ali's econ materials before committing to a design.

---

## Phase 5: Canvas LTI 1.3 Integration

**STATUS: SCOPE ONLY — must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Let instructors embed LLteacher assignments into Canvas; let students click through from Canvas → LLteacher (auto-authenticated, auto-enrolled in the right Course); pull course rosters from Canvas. **Explicit non-goal for v1: grade passback** — every PI said this is where Canvas integrations stall, and Sara's "fake assignment + manual link" workaround is good enough through the fall pilot.

**Depends on:** Phase 3 (Canvas roster → tenant identity mapping); Phase 6 hosting decisions affect LTI deployment URL.

**Files affected (rough scope):**
- Create: `apps/lti/` Django app with `LTIPlatform`, `LTIDeployment`, `LTILaunchSession` models
- Add: `pylti1.3` (or vendor a minimal LTI 1.3 implementation) to `pyproject.toml`
- Create: `apps/lti/src/lti/views.py` — OIDC login init, launch handler (validates JWT, resolves Canvas course → LLteacher Course, creates session)
- Modify: `src/llteacher/urls.py` — mount `/lti/` routes
- Create: management command `canvas_sync_roster <canvas_course_id>` that pulls members via Canvas API
- Templates: LTI tool config page (the developer-key JSON instructors paste into Canvas)

**Key design questions to settle in brainstorming:**
1. LTI Advantage extensions to claim — Names & Roles Provisioning (NRPS, for rosters), Deep Linking (for assignment selection inside Canvas), Assignment & Grade Services (AGS, deferred to v2)?
2. How is the Canvas → LLteacher Course mapping made — auto-create on first launch, or instructor-claims-pre-existing-Course?
3. Token storage for Canvas API access — per-instructor (asks them to authorize) or per-deployment service account?
4. Anonymous-user mode (what Sara has now) vs. real Canvas identity — preserve both?
5. UW-IT approval process — is an LLteacher developer key registered per-instructor, per-college, or campus-wide?
6. What happens for students who use the platform outside Canvas (Polya's terminal users, Lakshmi's healthcare providers who may not have Canvas accounts)?

**Estimated effort:** 2–2.5 weeks of engineering; **the calendar-time bottleneck is UW Canvas team availability for developer-key provisioning** — start that paperwork at the beginning of Phase 1.

**Next step:** Identify the UW-IT contact for LTI developer-key requests; brainstorm + plan in parallel with the request being processed.

---

## Phase 6: UW Hosting + FERPA/HIPAA Compliance

**STATUS: SCOPE ONLY — process-heavy; engineering portion must be re-planned via `/superpowers:writing-plans` before execution.**

**Goal:** Move from current single-instance Coolify deployment to a UW-blessed hosting environment that meets FERPA (Sara, Laurel, Ali) and HIPAA (Lakshmi) requirements. Add SSO via UW NetID or WorkOS-mediated SAML. Establish data-handling contracts (BAAs) with OpenRouter or fall back to an enterprise OpenAI key.

**Depends on:** Phase 3 multi-tenancy (so SSO maps identities to the right Org/Course); cutover should happen after Phase 3 is stable.

**Files affected (rough scope):**
- Modify: `src/llteacher/production.py` — SAML/OIDC settings, real `SECRET_KEY` handling via env, `SECURE_*` hardening
- Modify: `apps/accounts/src/accounts/utils.py` and `apps/accounts/src/accounts/views.py` — replace email/password registration with SSO-only when running on UW infra
- Add: `python-saml` (or `mozilla-django-oidc`) to `pyproject.toml`
- Modify: `Dockerfile` / new IaC — move database from SQLite to managed Postgres (Neon, or UW-blessed alternative); secret management via env vars in the hosting platform
- Create: data-handling document (`docs/compliance/data-flows.md`) listing every place PII or PHI crosses a boundary (browser → app → DB → OpenRouter → model provider) for the FERPA/HIPAA reviewer

**Key design questions to settle (mostly with stakeholders, not engineering):**
1. Hosting platform — UW-IT cloud, UW-blessed Azure (with BAA), an SSE-managed cluster, or staying on Coolify with hardened config?
2. Identity — UW NetID SAML direct, WorkOS as an SSO multiplexer, or both?
3. LLM provider for HIPAA workloads — does OpenRouter have a BAA? If not, route Clinical Informatics traffic to an enterprise OpenAI key (which does) while other courses use OpenRouter.
4. PII scrubbing in prompts — is current "we send anonymized content" guarantee documented, tested, and auditable? Add a middleware that asserts no `User.email`, `User.username`, or `Student.user.first_name`/`last_name` enters the LLM payload.
5. Audit logging — where do conversation logs live for FERPA/HIPAA review?
6. Data retention + deletion — how does a student exercise "delete my data"?
7. Backup/recovery for the Postgres tier.

**Estimated effort:** Code work ~1 week. **Calendar time is dominated by UW-IT, legal, and BAA review — start day 1 of the engagement.**

**Next step:** Identify and engage the UW-IT compliance contact for FERPA review and (if Lakshmi's tutor stays in scope) HIPAA review. Engineering tasks come after those conversations clarify constraints.

---

## Self-Review Notes

**Spec coverage:** All four PIs' stated needs map to phases — multi-model (P1), Polya state machine (P2), RAG (P4), Canvas (P5), FERPA/HIPAA (P6), multi-tenancy is the connective tissue (P3). Conversation-quality grading (Sara's pattern) is already in the codebase and doesn't need a new phase; future plans should preserve it as the cross-runtime evaluation surface.

**Placeholder scan:** Phase 1 contains no placeholders — every step has either explicit code, a concrete command, or a manual verification check. Phases 2–6 contain scope-level descriptions and design questions, **clearly labeled `STATUS: SCOPE ONLY`** with explicit instructions to re-plan via `/superpowers:writing-plans` before execution. Per the skill's guidance, those phases are not safe to execute from this document.

**Type consistency:** In Phase 1, the field name `base_url` is used identically across model, dataclass, view parser, template, README, and tests. In Phase 2, the proposed types `TurnInput`, `TurnEvent`, `AgentRuntime` are defined in one place and referenced consistently in the scope description.

---

## Execution Handoff (Phase 1 only)

Phase 1 is execution-ready. Phases 2–6 require their own dedicated `/superpowers:writing-plans` runs against the design questions listed in each phase before any code is written.
